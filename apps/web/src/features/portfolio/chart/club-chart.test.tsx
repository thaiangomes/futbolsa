// @vitest-environment jsdom
import type { CandlesResponse, ChartCandle, MarkersResponse, MyTradesResponse } from "@futbolsa/contracts";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { created, live } from "../../../test-support/fake-charts";
import { useDom } from "../../../test-support/dom";
import type { PortfolioApi } from "../api";
import { ClubChart } from "./club-chart";

vi.mock("lightweight-charts", async () => (await import("../../../test-support/fake-charts")).fakeCharts);

// T13: o gráfico do clube (Carteira e gráficos 22 a 28, 34).

const candle = (start: string, o: number, h: number, l: number, c: number, v: number): ChartCandle => ({ start, open: o, high: h, low: l, close: c, volume: v, turnover: v * 100 });
const response = (over: Partial<CandlesResponse> = {}): CandlesResponse => ({
  seq: 3,
  range: "today",
  interval: "15m",
  from: "2027-04-06T13:00:00.000Z",
  to: "2027-04-06T13:30:00.000Z",
  ipoPrice: 3500,
  tradingOpensAt: "2027-04-05T13:00:00.000Z",
  candles: [candle("2027-04-06T13:00:00.000Z", 4000, 4200, 3950, 4150, 30), candle("2027-04-06T13:15:00.000Z", 4150, 4150, 4150, 4150, 0), candle("2027-04-06T13:30:00.000Z", 4150, 4150, 4150, 4150, 0)],
  ...over,
});
const markers: MarkersResponse = {
  range: "today",
  games: [{ at: "2027-04-06T13:05:00.000Z", competition: "brasileirao-a", round: 5, phase: null, opponent: { ticker: "PAL3", name: "Palmeiras" }, home: true, status: "finished", goalsFor: 2, goalsAgainst: 1, result: "V", advanced: null }],
  payouts: [{ at: "2027-04-06T13:20:00.000Z", kind: "payout", reason: "3 pontos na rodada 5", perShare: 30, status: "pending", buyback: false }],
};
const mine: MyTradesResponse = { range: "today", trades: [{ at: "2027-04-06T13:01:00.000Z", side: "buy", quantity: 1000, price: 3500 }], averagePrice: 3700 };

function fakeApi(over: Partial<PortfolioApi> = {}) {
  return {
    candles: vi.fn(async (_t: string, range: string) => response({ range: range as never })),
    markers: vi.fn(async () => markers),
    myTrades: vi.fn(async () => mine),
    ...over,
  } as unknown as PortfolioApi & { candles: ReturnType<typeof vi.fn>; markers: ReturnType<typeof vi.fn>; myTrades: ReturnType<typeof vi.fn> };
}

describe("ClubChart", () => {
  const dom = useDom();
  beforeEach(() => {
    created.length = 0;
  });
  // a biblioteca carrega por importação dinâmica: deixa a promessa terminar
  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  };

  it("carteira 22: linha com volume, marcadores de jogo, dividendo e meus negócios, e as linhas do IPO e do preço médio", async () => {
    const api = fakeApi();
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api, logged: true }));
    await flush();
    const chart = live().at(-1)!;
    expect(chart.price()!.kind).toBe("Line");
    expect(chart.price()!.data).toHaveLength(3);
    expect(chart.volume()!.data).toHaveLength(3);
    expect(chart.price()!.markers.map((m) => m.id).sort()).toEqual(["game-0", "payout-0", "trade-0"]);
    expect(chart.price()!.lines.map((l) => [l.title, l.price])).toEqual([["IPO", 35], ["Preço médio", 37]]);
    expect(api.myTrades).toHaveBeenCalledWith("FLA3", "today");
    expect(dom.text()).toContain("Gráfico de FLA3");
    expect(dom.text()).toContain("IPO: R$ 35,00");
  });

  it("livro 48: o volume fica num painel próprio abaixo dos preços (eixo em R$ curto, sem rótulo de preço) e a legenda mostra o financeiro e as ações do período sob o cursor", async () => {
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: true }));
    await flush();
    const chart = live().at(-1)!;
    expect(chart.price()!.paneIndex).toBe(0);
    expect(chart.volume()!.paneIndex).toBe(1);
    expect(chart.stretch).toEqual([3, 1]);
    const options = chart.volume()!.options as { priceFormat: { type: string; formatter: (v: number) => string }; lastValueVisible: boolean };
    expect(options.priceFormat.type).toBe("custom");
    expect(options.priceFormat.formatter(2407)).toBe("R$ 2,4 mil");
    expect(options.lastValueVisible).toBe(false);
    // o eixo de preços fica só com preço: nenhuma série de volume desenhada na escala dele
    expect((chart.price()!.options as { priceFormat: { formatter: (v: number) => string } }).priceFormat.formatter(38.23)).toBe("38,23");
    expect(chart.options.localization).not.toHaveProperty("priceFormatter");
    // sem cursor, a legenda explica; com o cursor num período, mostra o valor negociado e a quantidade
    expect(dom.$("[data-testid=volume-info]").textContent).toContain("passe o mouse ou toque");
    const first = (chart.volume()!.data[0] as { time: number }).time;
    const { act } = await import("react");
    await act(async () => chart.crosshair!({ time: first }));
    expect(dom.$("[data-testid=volume-info]").textContent).toMatch(/Volume em .*: R\$ .* · .* ações?/);
    await act(async () => chart.crosshair!({}));
    expect(dom.$("[data-testid=volume-info]").textContent).toContain("passe o mouse ou toque");
  });

  it("carteira 28: sem login não pede os meus negócios e a linha do preço médio some; sem ações só a do IPO", async () => {
    const api = fakeApi({ myTrades: vi.fn(async () => ({ ...mine, trades: [], averagePrice: null })) as never });
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api, logged: true }));
    await flush();
    expect(live().at(-1)!.price()!.lines.map((l) => l.title)).toEqual(["IPO"]);
    created.length = 0;
    const visitor = fakeApi();
    await dom.render(createElement(ClubChart, { ticker: "PAL3", api: visitor, logged: false }));
    await flush();
    expect(visitor.myTrades).not.toHaveBeenCalled();
  });

  it("alterna para candles e troca o período pela REST", async () => {
    const api = fakeApi();
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api, logged: false }));
    await flush();
    await dom.click(dom.button("Candles"));
    await flush();
    expect(live().at(-1)!.price()!.kind).toBe("Candlestick");
    await dom.click(dom.button("7 dias"));
    await flush();
    expect(api.candles).toHaveBeenLastCalledWith("FLA3", "7d");
  });

  it("o candle do canal substitui o último sem repetir e a virada recarrega a janela", async () => {
    const api = fakeApi();
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api, logged: false }));
    await flush();
    const event = { interval: "15m", start: "2027-04-06T13:30:00.000Z", open: 4150, high: 4300, low: 4150, close: 4300, volume: 7, turnover: 30_100 };
    await dom.realtime.emit("club:FLA3", "candle", event, 4);
    await flush();
    const line = live().at(-1)!.price()!.data as { value: number }[];
    expect(line).toHaveLength(3);
    expect(line.at(-1)!.value).toBe(43);
    expect(api.candles).toHaveBeenCalledTimes(1);
    // o mesmo evento de novo não muda nada
    await dom.realtime.emit("club:FLA3", "candle", event, 5);
    await flush();
    expect((live().at(-1)!.price()!.data as unknown[]).length).toBe(3);
    // um período mais novo que o último: a virada
    await dom.realtime.emit("club:FLA3", "candle", { ...event, start: "2027-04-06T13:45:00.000Z" }, 6);
    await flush();
    expect(api.candles).toHaveBeenCalledTimes(2);
  });

  it("o balão abre ao clicar no marcador e fecha; a lista de texto traz os mesmos marcadores", async () => {
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: true }));
    await flush();
    await act(async () => live().at(-1)!.click!({ hoveredObjectId: "game-0" }));
    expect(dom.$("[data-testid=balao-marcador]").textContent).toContain("Brasileirão, rodada 5");
    expect(dom.$("[data-testid=balao-marcador]").textContent).toContain("FLA3 2 × 1 PAL3 · V");
    await dom.click(dom.$("[data-testid=balao-marcador] button"));
    expect(dom.$("[data-testid=balao-marcador]")).toBeNull();
    expect(dom.$$("[data-testid=lista-marcadores] li")).toHaveLength(3);
    expect(dom.text()).toContain("Aguardando aprovação");
  });

  it("estado vazio antes da abertura", async () => {
    const empty = fakeApi({ candles: vi.fn(async () => response({ candles: [], tradingOpensAt: "2027-04-20T13:00:00.000Z" })) as never });
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: empty, logged: false }));
    await flush();
    expect(dom.$("[data-testid=grafico-vazio]").textContent).toBe("Negociação abre às 10h00.");
  });

  it("erro ao carregar mostra o aviso com nova tentativa; nenhuma imagem de clube", async () => {
    const broken = fakeApi({ candles: vi.fn(async () => { throw new Error("x"); }) as never });
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: broken, logged: false }));
    await flush();
    expect(dom.$("[data-testid=grafico-erro]")).not.toBeNull();
    expect(dom.$$("img")).toHaveLength(0);
  });

  it("o eixo mostra o horário de Brasília", async () => {
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: false }));
    await flush();
    const timeScale = (live().at(-1)!.options.timeScale ?? {}) as { tickMarkFormatter: (t: number) => string };
    expect(timeScale.tickMarkFormatter(Date.parse("2027-04-06T13:15:00Z") / 1000)).toBe("10:15");
  });
});
