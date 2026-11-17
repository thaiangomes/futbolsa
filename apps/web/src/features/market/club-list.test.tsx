// @vitest-environment jsdom
import type { ClubList as ClubListData } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import type { MarketApi } from "./api";
import { applyPriceToList, ClubList } from "./club-list";

// W8 do Plano do livro de ofertas e formador: a lista de clubes com os avisos "em jogo agora", "em leilão até…" e "suspenso".

const item = (ticker: string, over: Record<string, unknown> = {}) => ({
  ticker,
  name: ticker === "FLA3" ? "Flamengo" : "Palmeiras",
  division: "A" as const,
  price: 4000,
  changeBp: 0,
  matchMode: false,
  auction: null,
  suspended: null,
  nextMatch: null,
  ...over,
});
const list = (over: Partial<ClubListData> = {}): ClubListData => ({
  seq: 0,
  market: { state: "open", opensAt: "2027-04-05T13:00:00.000Z", reason: null },
  clubs: [item("FLA3"), item("PAL3")],
  ...over,
});
const api = (data: ClubListData): MarketApi => ({ clubs: vi.fn(async () => data) }) as unknown as MarketApi;

describe("applyPriceToList", () => {
  it("atualiza preço, variação e leilão do clube; clube desconhecido não muda nada", () => {
    const base = list();
    const next = applyPriceToList(base, { ticker: "FLA3", price: 4200, changeBp: 500, auction: { until: "2027-04-05T18:40:00.000Z" } });
    expect(next.clubs[0]).toMatchObject({ ticker: "FLA3", price: 4200, changeBp: 500, auction: { until: "2027-04-05T18:40:00.000Z" } });
    expect(next.clubs[1]).toEqual(base.clubs[1]);
    expect(applyPriceToList(base, { ticker: "XXX3", price: 1, changeBp: 0, auction: null })).toBe(base);
  });
});

describe("lista de clubes (tela)", () => {
  const dom = useDom();

  it("mostra ticker, nome, preço e variação, com link para a tela do clube", async () => {
    await dom.render(createElement(ClubList, { api: api(list({ clubs: [item("FLA3", { price: 4430, changeBp: 302 })] })) }));
    await dom.settle();
    const row = dom.$("[data-testid=clube]");
    expect(row.textContent).toContain("FLA3");
    expect(row.textContent).toContain("Flamengo");
    expect(row.textContent).toContain("R$ 44,30");
    expect(row.textContent).toContain("▲ +3,02%");
    expect(dom.$("[data-testid=link-clube]").getAttribute("href")).toBe("/clube?t=FLA3");
  });

  it("livro 46: com a carteira lida, mostra a coluna Você tem com as ações de cada clube (e traço onde não tem)", async () => {
    const positions = new Map([["FLA3", { shares: 1200, inOrders: 0, averagePrice: 3700 }]]);
    await dom.render(createElement(ClubList, { api: api(list()), positions }));
    await dom.settle();
    expect(dom.$$("[data-testid=minha-posicao]").map((c) => c.textContent)).toEqual(["1.200", "—"]);
    expect(dom.text()).toContain("Você tem");
  });

  it("a coluna Próximo jogo mostra o adversário com selo, o mando, a data e a hora de Brasília e a competição (ou traço sem jogo marcado)", async () => {
    const nextMatch = { kickoff: "2027-04-18T19:00:00.000Z", competition: "brasileirao-a" as const, round: 12, phase: null, home: true, opponent: { ticker: "PAL3", name: "Palmeiras" }, inPlay: false };
    await dom.render(createElement(ClubList, { api: api(list({ clubs: [item("FLA3", { nextMatch }), item("PAL3")] })) }));
    await dom.settle();
    const [fla, pal] = dom.$$("[data-testid=proximo-jogo]");
    expect(fla!.textContent).toContain("PAL3 (casa)");
    expect(fla!.textContent).toContain("18/04 16h00 · Brasileirão");
    expect(fla!.querySelector("[data-testid=selo]")!.getAttribute("aria-label")).toBe("Selo PAL3, Palmeiras");
    expect(pal!.textContent).toBe("—");
    expect(dom.text()).toContain("Próximo jogo");
  });

  it("o jogo que já começou aparece como agora na coluna, e o adversário de fora da lista pelo nome", async () => {
    const nextMatch = { kickoff: "2027-04-18T19:00:00.000Z", competition: "sulamericana" as const, round: null, phase: "oitavas", home: false, opponent: { ticker: null, name: "Clube de Fora" }, inPlay: true };
    await dom.render(createElement(ClubList, { api: api(list({ clubs: [item("FLA3", { nextMatch })] })) }));
    await dom.settle();
    const cell = dom.$("[data-testid=proximo-jogo]").textContent!;
    expect(cell).toContain("Clube de Fora (fora)");
    expect(cell).toContain("agora · Sul-Americana");
  });

  it("sem a carteira (visitante), a lista não tem a coluna Você tem", async () => {
    await dom.render(createElement(ClubList, { api: api(list()) }));
    await dom.settle();
    expect(dom.$("[data-testid=minha-posicao]")).toBeNull();
    expect(dom.text()).not.toContain("Você tem");
  });

  it("mostra \"em jogo agora\", \"em leilão até 15h40\" e \"suspenso\" nos clubes certos", async () => {
    const clubs = [
      item("FLA3", { matchMode: true }),
      item("PAL3", { auction: { until: "2027-04-05T18:40:00.000Z" } }),
      item("SPT3", { suspended: { reason: "Placar errado" }, matchMode: true }),
    ];
    await dom.render(createElement(ClubList, { api: api(list({ clubs })) }));
    await dom.settle();
    const by = (t: string) => dom.$(`[data-ticker="${t}"]`).textContent ?? "";
    expect(by("FLA3")).toContain("Em jogo agora");
    expect(by("PAL3")).toContain("Em leilão até 15h40");
    expect(by("SPT3")).toContain("Suspenso");
    expect(by("SPT3")).not.toContain("Em jogo agora");
  });

  it("um evento price do canal prices muda a lista sem recarregar; um com seq já contido na resposta é ignorado", async () => {
    const a = api(list({ seq: 10 }));
    await dom.render(createElement(ClubList, { api: a }));
    await dom.settle();
    expect(dom.realtime.subscribedChannels()).toContain("prices");
    await dom.realtime.emit("prices", "price", { ticker: "FLA3", price: 4300, changeBp: 750, auction: null }, 11);
    expect(dom.$('[data-ticker="FLA3"]').textContent).toContain("R$ 43,00");
    expect(dom.$('[data-ticker="FLA3"]').textContent).toContain("▲ +7,50%");
    expect(a.clubs).toHaveBeenCalledTimes(1);
  });

  it("uma suspensão no canal season relê a lista", async () => {
    const a = api(list());
    await dom.render(createElement(ClubList, { api: a }));
    await dom.settle();
    await dom.realtime.emit("season", "market.suspended", { scope: "club", ticker: "FLA3", reason: "x" });
    await dom.settle();
    expect(a.clubs).toHaveBeenCalledTimes(2);
  });

  it("antes da abertura avisa que a negociação não abriu", async () => {
    await dom.render(createElement(ClubList, { api: api(list({ market: { state: "not_open", opensAt: null, reason: null } })) }));
    await dom.settle();
    expect(dom.$("[data-testid=mercado-fechado]")).not.toBeNull();
  });

  it("sem resposta da API mostra o erro", async () => {
    const broken = { clubs: vi.fn(async () => Promise.reject(new Error("fora do ar"))) } as unknown as MarketApi;
    await dom.render(createElement(ClubList, { api: broken }));
    await dom.settle();
    expect(dom.text()).toContain("Não foi possível carregar os clubes");
  });
});

describe("coluna Sua projeção (critério 55)", () => {
  const dom = useDom();
  const view = (over: Record<string, unknown> = {}) => ({
    ticker: "FLA3",
    league: "brasileirao-a" as const,
    leagueRules: { perPoint: 10, placement: [500, 450, 400, 350, 300, 270, 240, 210, 180, 150, 120, 100, 80, 60, 40, 20] },
    leagueOpen: true,
    points: 20,
    position: 5,
    played: 9,
    paid: 270,
    toReceive: 30,
    buybackMultipleBp: 15_000,
    cups: [
      {
        competition: "copa-do-brasil" as const,
        phases: ["1a-fase", "2a-fase", "3a-fase", "oitavas", "quartas", "semifinal", "final"],
        advance: { "1a-fase": 50, "2a-fase": 75, "3a-fase": 100, oitavas: 150, quartas: 250, semifinal: 400 },
        title: 800,
        currentPhase: "oitavas",
        outcome: "playing" as const,
      },
    ],
    ...over,
  });
  const bet = { ticker: "FLA3", points: 68, position: 3, cups: { "copa-do-brasil": "quartas" }, updatedAt: "2027-06-10T18:00:00.000Z" };
  const withDividends = (data: ClubListData, v: unknown) => ({ ...api(data), dividends: vi.fn(async () => v) }) as unknown as MarketApi;

  it("livro 55: mostra o valor e o upside ou downside no clube com projeção e traço no que não tem", async () => {
    const data = list({ clubs: [item("FLA3", { price: 6000 }), item("PAL3")] });
    await dom.render(createElement(ClubList, { api: withDividends(data, view()), projections: new Map([["FLA3", bet]]) }));
    await dom.settle();
    await dom.settle();
    const cells = dom.$$("[data-testid=minha-projecao]").map((c) => c.textContent);
    expect(cells[0]).toMatch(/^R\$ \d+,\d{2} · downside \d+%$/);
    expect(cells[1]).toBe("—");
    expect(dom.text()).toContain("Sua projeção");
  });

  it("livro 55: projeção desatualizada mostra revisar, sem valor", async () => {
    const data = list({ clubs: [item("FLA3", { price: 6000 })] });
    // os pontos de hoje (50) já passam dos 40 que ela projetou
    await dom.render(createElement(ClubList, { api: withDividends(data, view({ points: 50 })), projections: new Map([["FLA3", { ...bet, points: 40 }]]) }));
    await dom.settle();
    await dom.settle();
    expect(dom.$("[data-testid=minha-projecao]").textContent).toBe("revisar");
  });

  it("livro 55: projeção com uma copa de que o clube já foi eliminado também mostra revisar (e uma sem essa copa mostra o valor)", async () => {
    const data = list({ clubs: [item("FLA3", { price: 6000 })] });
    const eliminado = view({ cups: [{ ...view().cups[0]!, currentPhase: null, outcome: "eliminated" as const }] });
    await dom.render(createElement(ClubList, { api: withDividends(data, eliminado), projections: new Map([["FLA3", bet]]) }));
    await dom.settle();
    await dom.settle();
    expect(dom.$("[data-testid=minha-projecao]").textContent).toBe("revisar");
    // revisada e salva de novo, já sem a copa: volta a ter valor
    await dom.render(createElement(ClubList, { api: withDividends(data, eliminado), projections: new Map([["FLA3", { ...bet, cups: {} }]]) }));
    await dom.settle();
    await dom.settle();
    expect(dom.$("[data-testid=minha-projecao]").textContent).toMatch(/^R\$ \d+,\d{2} · (downside|upside) \d+%$/);
  });

  it("livro 55: sem login (sem projeções), a coluna nem aparece", async () => {
    await dom.render(createElement(ClubList, { api: api(list()) }));
    await dom.settle();
    expect(dom.$$("[data-testid=minha-projecao]")).toHaveLength(0);
    expect(dom.text()).not.toContain("Sua projeção");
  });
});
