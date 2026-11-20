// @vitest-environment jsdom
import type { ClubList, EntriesResponse, EntryItem, EquityResponse, MyOrder, WalletView } from "@futbolsa/contracts";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDom } from "../../../test-support/dom";
import type { MarketApi } from "../../market/api";
import type { PortfolioApi } from "../api";
import { entryLabel } from "./sections";
import { WalletBody, WalletContent } from "./wallet-screen";

vi.setConfig({ testTimeout: 20_000 });
vi.mock("lightweight-charts", async () => (await import("../../../test-support/fake-charts")).fakeCharts);

// T15, T17 e T23: a página da carteira (Carteira e gráficos 1 a 5, 9 a 14, 17 a 19, 33, 34, 38 e 45).

const club = (ticker: string, name: string) => ({ ticker, name, badgeAbbr: null, colorPrimary: null, colorSecondary: null, badgePattern: null, badgeInk: null, badgeExtra: null });
const FLA = club("FLA3", "Flamengo");

const view = (over: Partial<WalletView> = {}): WalletView => ({
  seq: 1,
  at: "2027-04-06T18:00:00.000Z",
  cash: { total: 5_836_000, reserved: 400_000, free: 5_436_000 },
  negativeCash: false,
  receivable: 0,
  stocksValue: 5_280_000,
  equity: 11_116_000,
  returnBp: 1116,
  buybackClosed: false,
  positions: [
    {
      club: FLA,
      shares: 1200,
      inOrders: 500,
      free: 700,
      averagePrice: 3700,
      cost: 4_440_000,
      price: 4400,
      marketValue: 5_280_000,
      unrealized: 840_000,
      unrealizedPermille: 189,
      dividends: 36_000,
      receivable: 0,
      shareOfEquityPermille: 475,
      auction: null,
    },
  ],
  results: [{ club: FLA, realized: 240_000, unrealized: 840_000, dividends: 36_000, receivable: 0, total: 1_116_000 }],
  ...over,
});

const entry = (over: Partial<EntryItem> = {}): EntryItem => ({
  id: 10,
  at: "2027-04-06T16:00:00.000Z",
  kind: "trade",
  group: "trade",
  annulled: false,
  club: FLA,
  quantity: -300,
  price: 4500,
  amount: 1_350_000,
  realized: 240_000,
  cashAfter: 5_800_000,
  reason: null,
  payout: null,
  inAuction: false,
  ...over,
});

const equity: EquityResponse = {
  base: 10_000_000,
  startedAt: "2027-04-01T13:00:00.000Z",
  points: [{ day: "2027-04-05", equity: 10_100_000 }],
  current: { at: "2027-04-06T18:00:00.000Z", equity: 11_116_000 },
  dividendDays: [{ day: "2027-04-05", total: 36_000 }],
};

const order = (over: Partial<MyOrder> = {}): MyOrder => ({
  id: 7,
  ticker: "PAL3",
  side: "buy",
  type: "limit",
  quantity: 1000,
  filled: 400,
  limitPrice: 4000,
  reservedCash: 2_400_000,
  status: "open",
  cancelReason: null,
  createdAt: "2027-04-06T15:00:00.000Z",
  updatedAt: "2027-04-06T15:30:00.000Z",
  ...over,
});

const clubs = (auction: { until: string | null } | null): ClubList =>
  ({ seq: 1, market: { state: "open", opensAt: null, reason: null }, clubs: [{ ticker: "PAL3", name: "Palmeiras", division: "A", price: 4000, changeBp: 0, matchMode: false, auction, suspended: null }] }) as unknown as ClubList;

function apis(over: { wallet?: WalletView; entries?: EntriesResponse[]; orders?: MyOrder[]; auction?: { until: string | null } | null } = {}) {
  const pages = over.entries ?? [{ items: [entry()], nextCursor: null }];
  let page = 0;
  const portfolio = {
    wallet: vi.fn(async () => over.wallet ?? view()),
    entries: vi.fn(async () => pages[Math.min(page++, pages.length - 1)]!),
    equity: vi.fn(async () => equity),
  } as unknown as PortfolioApi & { wallet: ReturnType<typeof vi.fn>; entries: ReturnType<typeof vi.fn> };
  const market = {
    openOrders: vi.fn(async () => ({ orders: over.orders ?? [] })),
    clubs: vi.fn(async () => clubs(over.auction ?? null)),
    cancelOrder: vi.fn(async () => ({})),
  } as unknown as MarketApi & { cancelOrder: ReturnType<typeof vi.fn> };
  return { portfolio, market };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("página da carteira", () => {
  const dom = useDom();
  beforeEach(() => undefined);
  afterEach(() => vi.useRealTimers());
  const flush = async () => {
    const { act } = await import("react");
    await act(async () => {
      await wait(10);
    });
  };
  const open = async (a = apis()) => {
    await dom.render(createElement(WalletContent, { portfolio: a.portfolio, market: a.market, logged: true }));
    await flush();
    return a;
  };

  it("carteira 11 a 14: patrimônio, rentabilidade, caixa total, reservado e livre", async () => {
    await open();
    expect(dom.$("[data-testid=patrimonio]").textContent).toBe("R$ 111.160,00");
    expect(dom.$("[data-testid=rentabilidade]").textContent).toContain("▲ +11,16%");
    expect(dom.$("[data-testid=caixa-total]").textContent).toBe("R$ 58.360,00");
    expect(dom.$("[data-testid=caixa-reservado]").textContent).toBe("R$ 4.000,00");
    expect(dom.$("[data-testid=caixa-livre]").textContent).toBe("R$ 54.360,00");
    expect(dom.$("[data-testid=a-receber]").textContent).toBe("R$ 0,00");
  });

  it("carteira 17: o caixa negativo fica em destaque e o aviso aparece", async () => {
    await open(apis({ wallet: view({ negativeCash: true, cash: { total: -25_000, reserved: 0, free: -25_000 }, positions: [], results: [], stocksValue: 0, equity: -25_000, returnBp: -10025 }) }));
    expect(dom.$("[data-testid=caixa-total]").className).toContain("neg-cash");
    expect(dom.$("[data-testid=caixa-total]").textContent).toBe("−R$ 250,00");
    expect(dom.$("[data-testid=aviso-caixa-negativo]")).not.toBeNull();
    // o aviso diz o saldo, a causa (estorno ou rebaixamento) e o que fica bloqueado
    expect(dom.$("[data-testid=aviso-caixa-negativo]").textContent).toContain("−R$ 250,00");
    expect(dom.$("[data-testid=aviso-caixa-negativo]").textContent).toContain("rebaixamento");
    expect(dom.$("[data-testid=aviso-caixa-negativo]").textContent).toContain("compras ficam bloqueadas");
    expect(dom.$("[data-testid=sem-posicoes]")).not.toBeNull();
  });

  it("caixa zerado: aviso mais leve (compras bloqueadas), sem o alerta de caixa negativo", async () => {
    await open(apis({ wallet: view({ negativeCash: false, cash: { total: 0, reserved: 0, free: 0 } }) }));
    expect(dom.$("[data-testid=aviso-caixa-zerado]")).not.toBeNull();
    expect(dom.$("[data-testid=aviso-caixa-negativo]")).toBeNull();
  });

  it("o débito de rebaixamento aparece no extrato como débito, e o estorno comum continua estorno", () => {
    const base = { id: 1, at: "2027-12-05T21:00:00.000Z", kind: "reversal", group: "dividends", club: null, quantity: 0, price: null, amount: -15_000, realized: null, cashAfter: -5000, reason: "x", annulled: null, inAuction: null } as unknown as EntryItem;
    expect(entryLabel({ ...base, payout: { reason: "rebaixamento: 18º lugar", perShare: -100, shares: 150 } })).toBe("Débito de rebaixamento");
    expect(entryLabel({ ...base, payout: { reason: "3 pontos, rodada 5", perShare: -30, shares: 150 } })).toBe("Estorno");
  });

  it("carteira 1 a 5 e 9: a posição mostra preço médio, valor, resultado com % e a fatia; o resultado por clube soma o ganho", async () => {
    await open();
    const row = dom.$("[data-testid=posicao]");
    expect(row.textContent).toContain("R$ 37,00");
    expect(row.textContent).toContain("R$ 52.800,00");
    expect(row.textContent).toContain("+R$ 8.400,00");
    expect(row.textContent).toContain("▲ +18,9%");
    expect(row.textContent).toContain("500 em ordens");
    expect(row.textContent).toContain("47,5%");
    expect(dom.$("[data-testid=resultado]").textContent).toContain("+R$ 2.400,00");
    expect(dom.$("[data-testid=resultado]").textContent).toContain("+R$ 11.160,00");
  });

  it("livro 47: cada posição tem o atalho Negociar para a tela do clube dela", async () => {
    await open();
    const row = dom.$("[data-testid=posicao]");
    const link = dom.$("[data-testid=posicao] [data-testid=negociar]");
    expect(link.getAttribute("href")).toBe(`/clube?t=${row.getAttribute("data-ticker")}`);
    expect(link.getAttribute("aria-label")).toMatch(/^Negociar /);
  });

  it("carteira 33: wallet.changed no canal me atualiza a tela sem recarregar a página", async () => {
    const a = await open();
    expect(a.portfolio.wallet).toHaveBeenCalledTimes(1);
    a.portfolio.wallet.mockResolvedValueOnce(view({ equity: 11_300_000, returnBp: 1300 }));
    await dom.realtime.emit("me", "wallet.changed", { cash: 1, reserved: 0, club: null, version: 5 }, 2);
    await wait(400);
    await flush();
    expect(a.portfolio.wallet).toHaveBeenCalledTimes(2);
    expect(dom.$("[data-testid=patrimonio]").textContent).toBe("R$ 113.000,00");
  });

  it("em leilão: o evento price com leilão põe o aviso na posição e o sem leilão tira, sem recarregar", async () => {
    const a = await open();
    expect(dom.$("[data-testid=posicao] [data-testid=aviso-leilao]")).toBeNull();
    await dom.realtime.emit("prices", "price", { ticker: "FLA3", price: 4400, changeBp: 0, auction: { until: "2027-04-06T18:40:00.000Z" } }, 1);
    expect(dom.$("[data-testid=posicao] [data-testid=aviso-leilao]").textContent).toBe("Em leilão até 15h40");
    expect(a.portfolio.wallet).toHaveBeenCalledTimes(1);
    await dom.realtime.emit("prices", "price", { ticker: "FLA3", price: 4400, changeBp: 0, auction: { until: null } }, 2);
    expect(dom.$("[data-testid=posicao] [data-testid=aviso-leilao]").textContent).toBe("Leilão parado pela suspensão");
    await dom.realtime.emit("prices", "price", { ticker: "FLA3", price: 4400, changeBp: 0, auction: null }, 3);
    expect(dom.$("[data-testid=posicao] [data-testid=aviso-leilao]")).toBeNull();
    // o preço de outro clube não mexe nesta posição
    await dom.realtime.emit("prices", "price", { ticker: "PAL3", price: 4000, changeBp: 0, auction: { until: "2027-04-06T18:40:00.000Z" } }, 4);
    expect(dom.$("[data-testid=posicao] [data-testid=aviso-leilao]")).toBeNull();
  });

  it("carteira 18 e em leilão: a ordem aberta mostra pedidas, executadas e restantes e, no clube em leilão, o aviso e 'aguardando o leilão'", async () => {
    await open(apis({ orders: [order({ filled: 0 }), order({ id: 8, ticker: "SPT3" })], auction: { until: "2027-04-06T18:40:00.000Z" } }));
    const rows = dom.$$("[data-testid=ordem-aberta]");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.querySelector("[data-testid=andamento-ordem]")!.textContent).toContain("1.000 pedidas · 400 executadas · 600 restantes");
    expect(rows[0]!.querySelector("[data-testid=aviso-leilao]")!.textContent).toBe("Em leilão até 15h40");
    expect(rows[0]!.querySelector("[data-testid=aguardando-leilao]")).not.toBeNull();
    // SPT3 não está em leilão
    expect(rows[1]!.querySelector("[data-testid=aviso-leilao]")).toBeNull();
    // o preço do canal tira o aviso
    await dom.realtime.emit("prices", "price", { ticker: "PAL3", price: 4000, changeBp: 0, auction: null }, 5);
    expect(dom.$$("[data-testid=ordem-aberta]")[0]!.querySelector("[data-testid=aviso-leilao]")).toBeNull();
  });

  it("cancelar uma ordem chama a API e relê as ordens", async () => {
    const a = apis({ orders: [order()] });
    await open(a);
    await dom.click(dom.button("Cancelar"));
    expect(a.market.cancelOrder).toHaveBeenCalledWith(7);
    expect((a.market.openOrders as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("extrato: linhas com realizado e caixa depois, 'no leilão' só no negócio marcado, dividendo com o evento e carregar mais", async () => {
    const page1: EntriesResponse = {
      items: [
        entry({ id: 12, inAuction: true, kind: "trade" }),
        entry({ id: 11, kind: "dividend", group: "dividend", quantity: 0, price: null, amount: 36_000, realized: null, payout: { reason: "3 pontos, rodada 5", perShare: 30, shares: 1200 } }),
      ],
      nextCursor: "c1",
    };
    const page2: EntriesResponse = { items: [entry({ id: 9, kind: "reversal", group: "dividend", quantity: 0, price: null, amount: -6000, realized: null, reason: "erro de pontuação" })], nextCursor: null };
    const a = await open(apis({ entries: [page1, page2] }));
    const rows = dom.$$("[data-testid=linha-extrato]");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector("[data-testid=marca-leilao]")!.textContent).toBe("no leilão");
    expect(rows[1]!.querySelector("[data-testid=marca-leilao]")).toBeNull();
    expect(rows[0]!.textContent).toContain("−300");
    expect(rows[0]!.textContent).toContain("+R$ 2.400,00");
    expect(rows[1]!.textContent).toContain("3 pontos, rodada 5 · R$ 0,30 × 1.200 ações");
    await dom.click(dom.$("[data-testid=carregar-mais]"));
    expect(a.portfolio.entries).toHaveBeenLastCalledWith(expect.objectContaining({ before: "c1" }));
    expect(dom.$$("[data-testid=linha-extrato]")).toHaveLength(3);
    expect(dom.text()).toContain("erro de pontuação");
    expect(dom.$("[data-testid=carregar-mais]")).toBeNull();
  });

  it("extrato: o filtro por clube e por tipo refaz a leitura da primeira página", async () => {
    const a = await open();
    const club = dom.$<HTMLSelectElement>("#f-clube");
    await import("react").then(({ act }) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
        setter.call(club, "FLA3");
        club.dispatchEvent(new Event("change", { bubbles: true }));
      }),
    );
    await flush();
    expect(a.portfolio.entries).toHaveBeenLastCalledWith(expect.objectContaining({ club: "FLA3" }));
  });

  it("entry.added no canal me relê o início do extrato", async () => {
    const a = await open();
    const before = a.portfolio.entries.mock.calls.length;
    await dom.realtime.emit("me", "entry.added", { version: 6, at: "2027-04-06T18:00:00.000Z", kind: "trade", ticker: "FLA3", cashDelta: -100, reservedCashDelta: 0, sharesDelta: 1, price: 100, cashAfter: 1 }, 2);
    await wait(400);
    await flush();
    expect(a.portfolio.entries.mock.calls.length).toBe(before + 1);
  });

  it("carteira 34: nenhum escudo nem imagem de clube; o selo mostra o ticker e o nome", async () => {
    await open();
    expect(dom.$$("img")).toHaveLength(0);
    expect(dom.$$("svg")).toHaveLength(0);
    expect(dom.$("[data-testid=posicao] [data-testid=selo-clube]").textContent).toContain("FLA3");
    expect(dom.$("[data-testid=posicao] [data-testid=selo-clube]").textContent).toContain("Flamengo");
  });

  it("sem carteira (404), mostra o convite", async () => {
    const a = apis();
    a.portfolio.wallet.mockRejectedValue(Object.assign(new Error("x"), { status: 404 }));
    await open(a);
    expect(dom.$("[data-testid=sem-carteira]")).not.toBeNull();
  });

  it("com erro de rede, mostra o aviso de que não deu para carregar", async () => {
    const b = apis();
    b.portfolio.wallet.mockRejectedValue(new Error("rede"));
    await open(b);
    expect(dom.text()).toContain("Não foi possível carregar a carteira");
  });
});

describe("carteira no celular", () => {
  const dom = useDom();
  const props = (over: Partial<Parameters<typeof WalletBody>[0]> = {}) => ({
    view: view(),
    entries: { items: [entry()], loaded: true, hasMore: false, loadingMore: false, error: false, loadMore: async () => undefined, reload: async () => undefined },
    filter: {},
    onFilter: () => undefined,
    orders: [order()],
    auctions: new Map(),
    equity: null,
    onCancel: () => undefined,
    busyId: null,
    cancelError: null,
    narrow: true,
    ...over,
  });

  it("carteira 34: abas Resumo, Posições, Ordens e Extrato, uma seção por vez", async () => {
    await dom.render(createElement(WalletBody, props()));
    expect(dom.$$(".tabs button").map((b) => b.textContent)).toEqual(["Resumo", "Posições", "Ordens", "Extrato"]);
    expect(dom.$("[data-testid=resumo]")).not.toBeNull();
    expect(dom.$("[data-testid=posicoes]")).toBeNull();
    await dom.click(dom.button("Posições"));
    expect(dom.$("[data-testid=posicoes]")).not.toBeNull();
    expect(dom.$("[data-testid=resumo]")).toBeNull();
    await dom.click(dom.button("Ordens"));
    expect(dom.$("[data-testid=ordens-abertas]")).not.toBeNull();
    await dom.click(dom.button("Extrato"));
    expect(dom.$("[data-testid=extrato]")).not.toBeNull();
  });

  it("em leilão: o aviso da posição aparece na aba Posições, no mesmo lugar do computador", async () => {
    const v = view();
    v.positions[0] = { ...v.positions[0]!, auction: { until: "2027-04-06T18:40:00.000Z" } };
    await dom.render(createElement(WalletBody, props({ view: v })));
    await dom.click(dom.button("Posições"));
    expect(dom.$("[data-testid=aviso-leilao]").textContent).toBe("Em leilão até 15h40");
  });
});
