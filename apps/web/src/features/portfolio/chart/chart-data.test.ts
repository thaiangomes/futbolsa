import type { ChartCandle, GameMarker, MyTrade, PayoutMarker } from "@futbolsa/contracts";
import { describe, expect, it } from "vitest";
import { formatBp, formatChartClock, formatChartDay, formatMoney, formatMonth, formatPermille, formatSignedMoney, toneClass } from "../format";
import { gameContext, resultText, scoreLine } from "./labels";
import { aggregateTrades, buildMarkers } from "./markers";
import { applyCandleEvent, candleData, formatShortMoney, lineData, volumeData } from "./series";

// T12: mapeamento puro dos dados do gráfico (Carteira e gráficos 22 a 28).

const candle = (start: string, open: number, high: number, low: number, close: number, volume: number): ChartCandle => ({ start, open, high, low, close, volume, turnover: volume * 100 });
const sec = (iso: string) => Date.parse(iso) / 1000;

describe("formatos", () => {
  it("dinheiro em reais com sinal, percentuais com seta e decimos de ponto", () => {
    expect(formatMoney(5_800_000)).toBe("R$ 58.000,00");
    expect(formatMoney(-25_000)).toBe("−R$ 250,00");
    expect(formatSignedMoney(240_000)).toBe("+R$ 2.400,00");
    expect(formatSignedMoney(-140_000)).toBe("−R$ 1.400,00");
    expect(formatSignedMoney(0)).toBe("R$ 0,00");
    expect(formatBp(1116)).toBe("▲ +11,16%");
    expect(formatBp(-500)).toBe("▼ −5,00%");
    expect(formatBp(0)).toBe("0,00%");
    expect(formatPermille(475)).toBe("47,5%");
    expect(formatPermille(-333)).toBe("−33,3%");
    expect(toneClass(1)).toBe("up");
    expect(toneClass(-1)).toBe("down");
    expect(formatMonth("2027-05")).toBe("maio de 2027");
  });

  it("o eixo mostra o horário de Brasília (UTC−3), não o de UTC", () => {
    expect(formatChartClock(sec("2027-04-06T13:15:00Z"))).toBe("10:15");
    // 02h59 UTC ainda é o dia anterior em Brasília
    expect(formatChartDay(sec("2027-04-06T02:59:00Z"))).toBe("05/04");
    expect(formatChartDay(sec("2027-04-06T03:00:00Z"))).toBe("06/04");
  });
});

describe("séries", () => {
  const candles = [candle("2027-04-06T13:00:00.000Z", 4000, 4200, 3950, 4150, 30), candle("2027-04-06T13:15:00.000Z", 4150, 4150, 4000, 4000, 0)];

  it("carteira 22: linha pelo fechamento em reais, candles e volume colorido (alta e baixa)", () => {
    expect(lineData(candles)).toEqual([{ time: sec("2027-04-06T13:00:00Z"), value: 41.5 }, { time: sec("2027-04-06T13:15:00Z"), value: 40 }]);
    expect(candleData(candles)[0]).toEqual({ time: sec("2027-04-06T13:00:00Z"), open: 40, high: 42, low: 39.5, close: 41.5 });
    expect(volumeData(candles, { up: "U", down: "D" }).map((v) => [v.value, v.color])).toEqual([[30, "U"], [0, "D"]]);
  });

  it("livro 48: o volume do gráfico é o valor negociado em reais (preço × quantidade somados), não a quantidade de ações", () => {
    // 166 ações a R$ 14,50 em média: R$ 2.407,00 negociados
    const c: ChartCandle = { start: "2027-04-06T13:00:00.000Z", open: 1500, high: 1500, low: 1400, close: 1450, volume: 166, turnover: 240_700 };
    expect(volumeData([c], { up: "U", down: "D" })).toEqual([{ time: sec("2027-04-06T13:00:00Z"), value: 2407, color: "D" }]);
  });

  it("o eixo do volume usa o formato curto: R$ 850, R$ 2,4 mil, R$ 1,2 mi, R$ 3 bi", () => {
    expect(formatShortMoney(0)).toBe("R$ 0");
    expect(formatShortMoney(850)).toBe("R$ 850");
    expect(formatShortMoney(2407)).toBe("R$ 2,4 mil");
    expect(formatShortMoney(12_000)).toBe("R$ 12 mil");
    expect(formatShortMoney(1_234_000)).toBe("R$ 1,2 mi");
    expect(formatShortMoney(3_000_000_000)).toBe("R$ 3 bi");
  });

  it("carteira 23: o dia sem negócio chega com volume zero e fechamento repetido", () => {
    const flat = [candle("2027-04-07T03:00:00.000Z", 4000, 4000, 4000, 4000, 0)];
    expect(volumeData(flat, { up: "U", down: "D" })[0]!.value).toBe(0);
    expect(lineData(flat)[0]!.value).toBe(40);
  });

  it("o candle do canal substitui o último sem repetir; a virada pede a recarga; outro intervalo e candle velho são ignorados", () => {
    const event = { interval: "15m" as const, start: "2027-04-06T13:15:00.000Z", open: 4150, high: 4300, low: 4000, close: 4300, volume: 12, turnover: 51_600 };
    const first = applyCandleEvent(candles, "15m", event);
    expect(first.kind).toBe("replace");
    if (first.kind !== "replace") return;
    expect(first.candles[1]).toMatchObject({ high: 4300, close: 4300, volume: 12 });
    // aplicar de novo (o mesmo evento chegando duas vezes) dá o mesmo
    const again = applyCandleEvent(first.candles, "15m", event);
    expect(again).toEqual({ kind: "replace", candles: first.candles });
    expect(first.candles).toHaveLength(2);
    expect(applyCandleEvent(candles, "15m", { ...event, start: "2027-04-06T13:30:00.000Z" })).toEqual({ kind: "reload" });
    expect(applyCandleEvent(candles, "1d", event)).toEqual({ kind: "ignore" });
    expect(applyCandleEvent(candles, "15m", { ...event, start: "2027-04-06T12:00:00.000Z" })).toEqual({ kind: "ignore" });
    expect(applyCandleEvent([], "15m", event)).toEqual({ kind: "reload" });
  });
});

describe("marcadores", () => {
  const game = (over: Partial<GameMarker> = {}): GameMarker => ({
    at: "2027-04-06T13:05:00.000Z",
    competition: "brasileirao-a",
    round: 5,
    phase: null,
    opponent: { ticker: "PAL3", name: "Palmeiras" },
    home: true,
    status: "finished",
    goalsFor: 2,
    goalsAgainst: 1,
    result: "V",
    advanced: null,
    ...over,
  });
  const window = { from: sec("2027-04-06T13:00:00Z"), to: sec("2027-04-06T18:00:00Z") };

  it("carteira 24: Brasileirão, rodada 5, FLA3 2 × 1 PAL3, V; e a visão do PAL3 em D", () => {
    expect(gameContext(game())).toBe("Brasileirão, rodada 5");
    expect(scoreLine("FLA3", game())).toBe("FLA3 2 × 1 PAL3");
    expect(scoreLine("PAL3", game({ home: false, opponent: { ticker: "FLA3", name: "Flamengo" }, goalsFor: 1, goalsAgainst: 2, result: "D" }))).toBe("FLA3 2 × 1 PAL3");
  });

  it("carteira 25: em andamento não mostra placar; adversário não listado usa o nome", () => {
    const live = game({ status: "live", goalsFor: null, goalsAgainst: null, result: null, opponent: { ticker: null, name: "Bragantino" } });
    expect(scoreLine("FLA3", live)).toBe("FLA3 × Bragantino");
    const [marker] = buildMarkers({ ticker: "FLA3", interval: "15m", window, games: [live], payouts: [], trades: [] });
    expect(marker).toMatchObject({ text: "●", tone: "amber", position: "aboveBar", shape: "circle" });
    expect(marker!.lines[1]).toBe("Em andamento");
  });

  it("carteira 42: pênaltis mostram E com classificou-se ou eliminado", () => {
    expect(resultText(game({ result: "E", advanced: true }))).toBe("E · classificou-se");
    expect(resultText(game({ result: "E", advanced: false }))).toBe("E · eliminado");
    expect(gameContext(game({ competition: "copa-do-brasil", round: null, phase: "oitavas" }))).toBe("Copa do Brasil, oitavas de final");
  });

  it("carteira 26 e 43: marcador de R$ 0,30 por ação, aguardando aprovação enquanto pendente, e o estorno", () => {
    const payouts: PayoutMarker[] = [
      { at: "2027-04-06T13:00:00.000Z", kind: "payout", reason: "3 pontos na rodada 5", perShare: 30, status: "pending", buyback: false },
      { at: "2027-04-06T14:00:00.000Z", kind: "reversal", reason: "1 ponto na rodada 5", perShare: -20, status: "approved", buyback: false },
    ];
    const markers = buildMarkers({ ticker: "FLA3", interval: "15m", window, games: [], payouts, trades: [] });
    expect(markers[0]).toMatchObject({ text: "R$ 0,30", shape: "square", tone: "dividend", title: "Dividendo" });
    expect(markers[0]!.lines).toContain("Aguardando aprovação: o valor pode mudar numa correção");
    expect(markers[1]).toMatchObject({ title: "Estorno de dividendo", text: "estorno −R$ 0,20" });
    expect(markers[1]!.lines.join(" ")).not.toContain("Aguardando");
  });

  it("carteira 27: meus negócios no mesmo candle e lado viram um marcador (quantidade somada, preço médio ponderado)", () => {
    const trades: MyTrade[] = [
      { at: "2027-04-06T13:01:00.000Z", side: "buy", quantity: 100, price: 4000 },
      { at: "2027-04-06T13:10:00.000Z", side: "buy", quantity: 300, price: 4400 },
      { at: "2027-04-06T13:12:00.000Z", side: "sell", quantity: 50, price: 4500 },
      { at: "2027-04-06T13:20:00.000Z", side: "buy", quantity: 10, price: 4100 },
    ];
    expect(aggregateTrades(trades, "15m")).toEqual([
      { time: sec("2027-04-06T13:00:00Z"), side: "buy", quantity: 400, price: 4300, count: 2 },
      { time: sec("2027-04-06T13:00:00Z"), side: "sell", quantity: 50, price: 4500, count: 1 },
      { time: sec("2027-04-06T13:15:00Z"), side: "buy", quantity: 10, price: 4100, count: 1 },
    ]);
    const markers = buildMarkers({ ticker: "FLA3", interval: "15m", window, games: [], payouts: [], trades });
    expect(markers.map((m) => [m.shape, m.position, m.text])).toEqual([
      ["arrowUp", "belowBar", "C 400"],
      ["arrowDown", "aboveBar", "V 50"],
      ["arrowUp", "belowBar", "C 10"],
    ]);
    // no gráfico diário os quatro caem no mesmo dia
    expect(aggregateTrades(trades, "1d").map((t) => [t.side, t.quantity])).toEqual([["buy", 410], ["sell", 50]]);
  });

  it("marcadores fora da janela do gráfico não aparecem", () => {
    const early = game({ at: "2027-04-05T13:00:00.000Z" });
    expect(buildMarkers({ ticker: "FLA3", interval: "15m", window, games: [early], payouts: [], trades: [] })).toEqual([]);
  });
});
