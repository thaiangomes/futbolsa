// @vitest-environment jsdom
import type { CandlesResponse, ChartCandle, EquityResponse, MarkersResponse, MyTradesResponse } from "@futbolsa/contracts";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { created, live } from "../../../test-support/fake-charts";
import { useDom } from "../../../test-support/dom";
import type { PortfolioApi } from "../api";
import { EquityChart } from "../equity/equity-chart";
import { ClubChart } from "./club-chart";
import { DEFAULT_MARKER_PREFS, filterMarkers, parseMarkerPrefs, resetMarkerPrefs } from "./marker-prefs";
import type { ChartMarker } from "./markers";

vi.mock("lightweight-charts", async () => (await import("../../../test-support/fake-charts")).fakeCharts);

// Carteira e gráficos, critérios 46 e 47 (item 21 das melhorias): o botão "Marcadores" do gráfico do clube e do patrimônio.

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
const game = (at: string, competition: string) => ({ at, competition, round: 5, phase: null, opponent: { ticker: "PAL3", name: "Palmeiras" }, home: true, status: "finished" as const, goalsFor: 2, goalsAgainst: 1, result: "V" as const, advanced: null });
const markers: MarkersResponse = {
  range: "today",
  games: [game("2027-04-06T13:05:00.000Z", "brasileirao-a"), game("2027-04-06T13:10:00.000Z", "copa-do-brasil")],
  payouts: [{ at: "2027-04-06T13:20:00.000Z", kind: "payout", reason: "3 pontos na rodada 5", perShare: 30, status: "pending", buyback: false }],
};
const mine: MyTradesResponse = { range: "today", trades: [{ at: "2027-04-06T13:01:00.000Z", side: "buy", quantity: 1000, price: 3500 }], averagePrice: 3700 };
const fakeApi = () =>
  ({ candles: vi.fn(async (_t: string, range: string) => response({ range: range as never })), markers: vi.fn(async () => markers), myTrades: vi.fn(async () => mine) }) as unknown as PortfolioApi;

describe("botão Marcadores (critérios 46 e 47)", () => {
  const dom = useDom();
  beforeEach(() => {
    created.length = 0;
    resetMarkerPrefs();
  });
  afterEach(() => resetMarkerPrefs());
  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  };
  const ids = () => live().at(-1)!.price()!.markers.map((m) => m.id).sort();
  const openMenu = async () => {
    await dom.click(dom.$("[data-testid=botao-marcadores]"));
  };
  const box = (label: string) => [...dom.$$("[data-testid=painel-marcadores] label")].find((l) => l.textContent === label)!.querySelector("input") as HTMLInputElement;

  it("carteira 46: o botão abre Dividendos, Minhas negociações e Jogos (e as competições com jogo), tudo ligado", async () => {
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: true }));
    await flush();
    expect(dom.$("[data-testid=painel-marcadores]")).toBeNull();
    await openMenu();
    expect([...dom.$$("[data-testid=painel-marcadores] label")].map((l) => l.textContent)).toEqual(["Dividendos", "Minhas negociações", "Jogos", "Brasileirão", "Copa do Brasil"]);
    expect([...dom.$$("[data-testid=painel-marcadores] input")].every((i) => (i as HTMLInputElement).checked)).toBe(true);
    expect(ids()).toEqual(["game-0", "game-1", "payout-0", "trade-0"]);
  });

  it("carteira 46: desligar Dividendos tira esses marcadores do gráfico e da lista; ligar traz de volta", async () => {
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: true }));
    await flush();
    await openMenu();
    await dom.click(box("Dividendos"));
    await flush();
    expect(ids()).toEqual(["game-0", "game-1", "trade-0"]);
    expect(dom.$$("[data-testid=lista-marcadores] li")).toHaveLength(3);
    await dom.click(box("Dividendos"));
    await flush();
    expect(ids()).toEqual(["game-0", "game-1", "payout-0", "trade-0"]);
  });

  it("carteira 46: desligar só a Copa do Brasil tira só os jogos dela; desligar Jogos tira todos e trava as competições", async () => {
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: true }));
    await flush();
    await openMenu();
    await dom.click(box("Copa do Brasil"));
    await flush();
    expect(ids()).toEqual(["game-0", "payout-0", "trade-0"]);
    await dom.click(box("Jogos"));
    await flush();
    expect(ids()).toEqual(["payout-0", "trade-0"]);
    expect(box("Brasileirão").disabled).toBe(true);
  });

  it("carteira 46: o visitante não vê Minhas negociações", async () => {
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: false }));
    await flush();
    await openMenu();
    expect([...dom.$$("[data-testid=painel-marcadores] label")].map((l) => l.textContent)).not.toContain("Minhas negociações");
  });

  it("carteira 47: a escolha continua ao recarregar a tela, ao trocar de período e em outro clube, e fica salva no navegador", async () => {
    await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: true }));
    await flush();
    await openMenu();
    await dom.click(box("Dividendos"));
    await dom.click(box("Copa do Brasil"));
    expect(JSON.parse(localStorage.getItem("futbolsa.marcadores")!)).toMatchObject({ payout: false, hiddenCompetitions: ["copa-do-brasil"] });
    // outro período
    await dom.click(dom.button("7 dias"));
    await flush();
    expect(ids()).toEqual(["game-0", "trade-0"]);
    // a tela recarregada, de outro clube: lê do que está salvo
    await dom.render(createElement(ClubChart, { ticker: "PAL3", api: fakeApi(), logged: true }));
    await flush();
    expect(ids()).toEqual(["game-0", "trade-0"]);
  });

  it("carteira 47: no gráfico de patrimônio da Carteira o botão só tem Dividendos, na mesma escolha do gráfico do clube", async () => {
    const equity: EquityResponse = {
      base: 10_000_000,
      startedAt: "2027-04-01T13:00:00.000Z",
      points: [{ day: "2027-04-05", equity: 10_100_000 }],
      current: { at: "2027-04-06T18:00:00.000Z", equity: 11_116_000 },
      dividendDays: [{ day: "2027-04-05", total: 36_000 }],
    };
    await dom.render(createElement(EquityChart, { data: equity }));
    await flush();
    expect(dom.$$("[data-testid=dias-com-dividendo] li")).toHaveLength(1);
    await openMenu();
    expect([...dom.$$("[data-testid=painel-marcadores] label")].map((l) => l.textContent)).toEqual(["Dividendos"]);
    await dom.click(box("Dividendos"));
    await flush();
    expect(dom.$("[data-testid=dias-com-dividendo]")).toBeNull();
    expect(JSON.parse(localStorage.getItem("futbolsa.marcadores")!).payout).toBe(false);
  });

  it("carteira 47: no celular o botão abre uma folha", async () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({ matches: query.includes("max-width"), media: query, addEventListener: () => undefined, removeEventListener: () => undefined });
    try {
      await dom.render(createElement(ClubChart, { ticker: "FLA3", api: fakeApi(), logged: true }));
      await flush();
      await openMenu();
      expect(dom.$("[data-testid=folha-marcadores]")).not.toBeNull();
      expect(dom.$("[data-testid=painel-marcadores]")).toBeNull();
    } finally {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  });
});

describe("preferências dos marcadores (funções puras)", () => {
  const m = (kind: ChartMarker["kind"], competition?: string): ChartMarker => ({ id: kind, time: 1, position: "aboveBar", shape: "circle", tone: "neutral", text: "", title: "", lines: [], kind, ...(competition ? { competition } : {}) });

  it("sem nada salvo, ou com lixo, tudo fica ligado", () => {
    expect(parseMarkerPrefs(null)).toEqual(DEFAULT_MARKER_PREFS);
    expect(parseMarkerPrefs("não é json")).toEqual(DEFAULT_MARKER_PREFS);
    expect(parseMarkerPrefs("42")).toEqual(DEFAULT_MARKER_PREFS);
    expect(parseMarkerPrefs('{"payout":false,"hiddenCompetitions":"x"}')).toEqual({ ...DEFAULT_MARKER_PREFS, payout: false });
  });

  it("o filtro tira dividendos, negociações, jogos ou só a competição desligada", () => {
    const all = [m("payout"), m("trade"), m("game", "libertadores"), m("game", "brasileirao-a")];
    expect(filterMarkers(all, DEFAULT_MARKER_PREFS)).toHaveLength(4);
    expect(filterMarkers(all, { ...DEFAULT_MARKER_PREFS, payout: false, trade: false }).map((x) => x.kind)).toEqual(["game", "game"]);
    expect(filterMarkers(all, { ...DEFAULT_MARKER_PREFS, game: false })).toHaveLength(2);
    expect(filterMarkers(all, { ...DEFAULT_MARKER_PREFS, hiddenCompetitions: ["libertadores"] }).map((x) => x.competition)).toEqual([undefined, undefined, "brasileirao-a"]);
  });
});
