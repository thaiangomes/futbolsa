// @vitest-environment jsdom
import type { IpoClubResult, IpoResults } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../../test-support/dom";
import { IpoScreen } from "../ipo-screen";
import { fakeApi, NOW_OPEN, openOverview, TRADING_AT } from "../test-fixtures";
import { ResultsScreen } from "./results-screen";

/** O exemplo do critério 16: oferta de 3.000, corte de R$ 35, fração 2/3; a Ana pediu 1.500 até R$ 40 e recebeu 1.000. */
const FLA3_RESULT: IpoClubResult = {
  ticker: "FLA3",
  name: "Flamengo",
  cutPrice: 3500,
  demandAtCut: 4500,
  ratio: { num: 2, den: 3 },
  leftoverShares: 0,
  lotShares: 600,
  myAllocation: { shares: 1000, paid: 3_500_000, refunded: 2_500_000 },
};
/** Clube em que o jogador não ofertou, e outro em que ofertou abaixo do corte (ipo 22). */
const PAL3_RESULT: IpoClubResult = { ticker: "PAL3", name: "Palmeiras", cutPrice: 2700, demandAtCut: 1200, ratio: { num: 1, den: 1 }, leftoverShares: 1800, lotShares: 600, myAllocation: null };
const SAO3_RESULT: IpoClubResult = { ticker: "SAO3", name: "São Paulo", cutPrice: 3000, demandAtCut: 3000, ratio: { num: 1, den: 1 }, leftoverShares: 0, lotShares: 600, myAllocation: { shares: 0, paid: 0, refunded: 1_200_000 } };

const settled = (clubs: IpoClubResult[]): IpoResults => ({ status: "settled", clubs });

describe("resultado do rateio (tela)", () => {
  const dom = useDom();
  const card = (ticker: string) => dom.$(`[data-ticker="${ticker}"]`);
  const cell = (ticker: string, label: string) =>
    [...card(ticker).querySelectorAll(".ipo-cell")].find((c) => c.querySelector(".ipo-k")?.textContent === label)?.querySelector(".ipo-v")?.textContent;

  it("ipo 16, 21 e 24: corte R$ 35, demanda 4.500, fração 2/3, 1.000 ações, pago R$ 35.000 e R$ 25.000 devolvidos", async () => {
    await dom.render(createElement(ResultsScreen, { clubs: [FLA3_RESULT], tradingOpensAt: TRADING_AT }));
    expect(cell("FLA3", "Preço de corte")).toBe("R$ 35,00");
    expect(cell("FLA3", "Demanda no preço")).toBe("4.500 ações");
    expect(cell("FLA3", "Fração do rateio")).toBe("2/3");
    expect(cell("FLA3", "Ações recebidas")).toBe("1.000");
    expect(cell("FLA3", "Valor pago")).toBe("R$ 35.000,00");
    expect(cell("FLA3", "Reserva devolvida")).toBe("R$ 25.000,00");
  });

  it("mostra o que foi para a tesouraria: a sobra da oferta e o lote do formador", async () => {
    await dom.render(createElement(ResultsScreen, { clubs: [FLA3_RESULT, PAL3_RESULT] }));
    expect(cell("FLA3", "Tesouraria")).toBe("0 da oferta + 600 do lote do formador");
    // ipo 18: demanda de 1.200 no piso, 1.800 vão para a tesouraria
    expect(cell("PAL3", "Preço de corte")).toBe("R$ 27,00");
    expect(cell("PAL3", "Tesouraria")).toBe("1.800 da oferta + 600 do lote do formador");
  });

  it("sem rateio (fração 1/1) diz que não houve rateio", async () => {
    await dom.render(createElement(ResultsScreen, { clubs: [SAO3_RESULT] }));
    expect(cell("SAO3", "Fração do rateio")).toBe("1/1 (sem rateio)");
  });

  it("ipo 22: oferta abaixo do corte recebe 0 ações e a reserva inteira de volta", async () => {
    await dom.render(createElement(ResultsScreen, { clubs: [SAO3_RESULT] }));
    expect(cell("SAO3", "Ações recebidas")).toBe("0");
    expect(cell("SAO3", "Valor pago")).toBe("R$ 0,00");
    expect(cell("SAO3", "Reserva devolvida")).toBe("R$ 12.000,00");
  });

  it("clube em que o jogador não ofertou não mostra ações, pago nem devolvido", async () => {
    await dom.render(createElement(ResultsScreen, { clubs: [PAL3_RESULT] }));
    expect(card("PAL3").textContent).toContain("Você não ofertou neste clube");
    expect(cell("PAL3", "Ações recebidas")).toBeUndefined();
    expect(cell("PAL3", "Valor pago")).toBeUndefined();
  });

  it("o resumo soma o que o jogador recebeu, pagou e teve devolvido em todos os clubes", async () => {
    await dom.render(createElement(ResultsScreen, { clubs: [FLA3_RESULT, PAL3_RESULT, SAO3_RESULT], tradingOpensAt: TRADING_AT }));
    expect(dom.$("[data-testid=resumo-acoes]").textContent).toContain("1.000");
    expect(dom.$("[data-testid=resumo-pago]").textContent).toContain("R$ 35.000,00");
    expect(dom.$("[data-testid=resumo-devolvido]").textContent).toContain("R$ 37.000,00");
    expect(dom.text()).toContain("05/04/2027");
    expect(dom.text()).toContain("preço de referência");
  });

  it("um cartão por clube, na ordem recebida", async () => {
    await dom.render(createElement(ResultsScreen, { clubs: [FLA3_RESULT, PAL3_RESULT, SAO3_RESULT] }));
    expect(dom.$$("[data-ticker]").map((el) => el.getAttribute("data-ticker"))).toEqual(["FLA3", "PAL3", "SAO3"]);
  });
});

describe("tela do IPO: o que mostrar depois do fechamento", () => {
  const dom = useDom();
  const overviewOf = (status: "ipo_open" | "ipo_closed" | "trading") => openOverview({ status });

  it("ipo 24: com tudo liquidado mostra o resultado em vez das ofertas", async () => {
    const api = fakeApi({ overview: async () => overviewOf("trading"), results: async () => settled([FLA3_RESULT]) });
    await dom.render(createElement(IpoScreen, { api, now: () => NOW_OPEN }));
    expect(dom.$("[data-testid=resultado]")).not.toBeNull();
    expect(dom.$("[data-testid=periodo]")).toBeNull();
    expect(dom.text()).toContain("R$ 35,00");
  });

  it("ipo 24: enquanto falta clube liquidar mostra 'liquidando…', sem números de resultado", async () => {
    const api = fakeApi({ overview: async () => overviewOf("ipo_closed"), results: async () => ({ status: "settling" as const }) });
    await dom.render(createElement(IpoScreen, { api, now: () => NOW_OPEN }));
    expect(dom.$("[data-testid=liquidando]").textContent).toContain("Liquidando…");
    expect(dom.$$("[data-ticker]")).toHaveLength(0);
    expect(dom.$("[data-testid=periodo]")).toBeNull();
  });

  it("pending mostra a tela de ofertas", async () => {
    const api = fakeApi({ overview: async () => overviewOf("ipo_open"), results: async () => ({ status: "pending" as const }) });
    await dom.render(createElement(IpoScreen, { api, now: () => NOW_OPEN }));
    expect(dom.$("[data-testid=periodo]")).not.toBeNull();
    expect(dom.$("[data-testid=liquidando]")).toBeNull();
  });

  it("fechado e ainda sem 'settling' (a tarefa vai liquidar): também mostra 'liquidando…'", async () => {
    const api = fakeApi({ overview: async () => overviewOf("ipo_closed"), results: async () => ({ status: "pending" as const }) });
    await dom.render(createElement(IpoScreen, { api, now: () => NOW_OPEN }));
    expect(dom.$("[data-testid=liquidando]")).not.toBeNull();
  });

  it("do 'liquidando…' ao resultado sem recarregar, quando a liquidação termina (wallet.changed / season.status)", async () => {
    let results: IpoResults = { status: "settling" };
    const resultsFn = vi.fn(async () => results);
    const api = fakeApi({ overview: async () => overviewOf("ipo_closed"), results: resultsFn });
    await dom.render(createElement(IpoScreen, { api, now: () => NOW_OPEN }));
    expect(dom.$("[data-testid=liquidando]")).not.toBeNull();
    results = settled([FLA3_RESULT]);
    await dom.realtime.emit("me", "wallet.changed", { cash: 6_500_000, reserved: 0, club: { ticker: "FLA3", shares: 1000 }, version: 9 });
    await dom.settle();
    expect(dom.$("[data-testid=resultado]")).not.toBeNull();
    expect(dom.$("[data-testid=liquidando]")).toBeNull();
  });
});
