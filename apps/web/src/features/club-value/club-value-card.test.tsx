// @vitest-environment jsdom
import type { ClubValueView } from "@futbolsa/contracts";
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import { ClubValueCard } from "./club-value-card";
import { cupOptions, initialForm, simulate } from "./model";

const PLACEMENT = [500, 450, 400, 350, 300, 270, 240, 210, 180, 150, 120, 100, 80, 60, 40, 20];

/** O FLA3 do critério 38: R$ 2,70 pagos, R$ 0,30 a receber, 20 pontos, 5º lugar, nas oitavas da Copa do Brasil e nos grupos da Libertadores. */
const fla3: ClubValueView = {
  ticker: "FLA3",
  league: "brasileirao-a",
  leagueRules: { perPoint: 10, placement: PLACEMENT },
  leagueOpen: true,
  points: 20,
  position: 5,
  paid: 270,
  toReceive: 30,
  buybackMultipleBp: 15_000,
  cups: [
    {
      competition: "copa-do-brasil",
      phases: ["1a-fase", "2a-fase", "3a-fase", "oitavas", "quartas", "semifinal", "final"],
      advance: { "1a-fase": 50, "2a-fase": 75, "3a-fase": 100, oitavas: 150, quartas: 250, semifinal: 400 },
      title: 800,
      currentPhase: "oitavas",
    },
    {
      competition: "libertadores",
      phases: ["grupos", "oitavas", "quartas", "semifinal", "final"],
      advance: { grupos: 150, oitavas: 225, quartas: 375, semifinal: 600 },
      title: 1200,
      currentPhase: "grupos",
    },
  ],
};

const apiOf = (view: ClubValueView) => ({ dividends: vi.fn(async () => view) });

describe("modelo do simulador (o mesmo motor da API)", () => {
  it("livro 38: simulando 68 pontos, 3º lugar, queda nas quartas das duas copas: faltam R$ 14,35, recompra R$ 25,58, valor R$ 39,93, preço 10,94% acima", () => {
    const r = simulate(fla3, 4430, { points: "68", position: "3", cups: { "copa-do-brasil": "quartas", libertadores: "quartas" } });
    expect(r.ok).toBe(true);
    const s = r.ok ? r.result.simulation! : null;
    expect(s!.missing.total).toBe(1435);
    expect(s!.buyback).toBe(2558);
    expect(s!.value).toBe(3993);
    expect(s!.priceGapBp).toBe(1094);
  });

  it("a aposta de partida é o clube terminar como está: sem pontos a mais e sem avançar nas copas (só a colocação atual e o a receber)", () => {
    expect(initialForm(fla3)).toEqual({ points: "20", position: "5", cups: { "copa-do-brasil": "oitavas", libertadores: "grupos" } });
    const r = simulate(fla3, 4430, initialForm(fla3));
    expect(r.ok && r.result.simulation!.missing.total).toBe(30 + 300); // R$ 0,30 a receber + R$ 3,00 do 5º lugar
  });

  it("as opções de cada copa vão da fase atual até a final e o título, com o que cada uma soma", () => {
    const opcoes = cupOptions(fla3.cups[0]!);
    expect(opcoes.map((o) => [o.value, o.label, o.extra])).toEqual([
      ["oitavas", "Cai nas oitavas", 0],
      ["quartas", "Cai nas quartas", 150],
      ["semifinal", "Cai na semifinal", 400],
      ["final", "Perde a final", 800],
      ["campeao", "Campeão", 1600],
    ]);
  });

  it("aposta incoerente volta com o motivo em português", () => {
    const abaixo = simulate(fla3, 4430, { points: "19", position: "3", cups: {} });
    expect(abaixo).toEqual({ ok: false, message: "O clube já tem 20 pontos: o fim do campeonato não pode ter menos." });
    expect(simulate(fla3, 4430, { points: "abc", position: "3", cups: {} })).toMatchObject({ ok: false, message: expect.stringContaining("número inteiro") });
    expect(simulate(fla3, 4430, { points: "500", position: "3", cups: {} })).toMatchObject({ ok: false });
  });
});

describe("cartão \"Quanto vale para você\" na tela do clube", () => {
  const dom = useDom();
  const pick = async (selector: string, value: string) => {
    const el = dom.$<HTMLSelectElement>(selector);
    await act(async () => {
      el.value = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("livro 38: com R$ 2,70 pagos, R$ 0,30 a receber e 20 pontos, mostra a recompra de R$ 4,50 se a temporada acabasse agora", async () => {
    const api = apiOf(fla3);
    await dom.render(createElement(ClubValueCard, { ticker: "FLA3", name: "Flamengo", price: 4430, api }));
    await dom.settle();
    await dom.settle();
    expect(api.dividends).toHaveBeenCalledWith("FLA3");
    expect(dom.$("[data-testid=valor-pago]").textContent).toContain("R$ 2,70");
    expect(dom.$("[data-testid=valor-a-receber]").textContent).toContain("R$ 0,30");
    expect(dom.$("[data-testid=valor-recompra-hoje]").textContent).toContain("R$ 4,50");
    expect(dom.$("[data-testid=valor-recompra-hoje]").textContent).toContain("1,5 × R$ 3,00");
    expect(dom.$("[data-testid=valor-pontos]").textContent).toContain("20 pontos");
  });

  it("livro 38: simulando 68 pontos, 3º lugar, queda nas quartas das duas copas, faltam R$ 14,35, a recompra é R$ 25,58, o valor R$ 39,93 e o preço fica 10,94% acima", async () => {
    await dom.render(createElement(ClubValueCard, { ticker: "FLA3", name: "Flamengo", price: 4430, api: apiOf(fla3) }));
    await dom.settle();
    await dom.settle();
    await dom.type("#sim-pontos", "68");
    await pick("#sim-colocacao", "3");
    await pick("#sim-copa-copa-do-brasil", "quartas");
    await pick("#sim-copa-libertadores", "quartas");
    expect(dom.$("[data-testid=sim-faltam]").textContent).toBe("R$ 14,35");
    expect(dom.$("[data-testid=sim-total]").textContent).toBe("R$ 17,05");
    expect(dom.$("[data-testid=sim-recompra]").textContent).toBe("R$ 25,58");
    expect(dom.$("[data-testid=sim-valor]").textContent).toBe("R$ 39,93");
    expect(dom.$("[data-testid=sim-comparacao]").textContent).toBe("O preço agora (R$ 44,30) está 10,94% acima da sua conta.");
    const conta = dom.$("[data-testid=sim-conta]").textContent!;
    for (const linha of ["R$ 4,80", "R$ 4,00", "R$ 1,50", "R$ 3,75", "R$ 0,30"]) expect(conta).toContain(linha);
  });

  it("o preço abaixo da conta aparece como abaixo, e o cálculo acompanha o preço novo", async () => {
    await dom.render(createElement(ClubValueCard, { ticker: "FLA3", name: "Flamengo", price: 3000, api: apiOf(fla3) }));
    await dom.settle();
    await dom.settle();
    await dom.type("#sim-pontos", "68");
    await pick("#sim-colocacao", "3");
    await pick("#sim-copa-copa-do-brasil", "quartas");
    await pick("#sim-copa-libertadores", "quartas");
    expect(dom.$("[data-testid=sim-comparacao]").textContent).toBe("O preço agora (R$ 30,00) está 24,87% abaixo da sua conta.");
  });

  it("pontos abaixo dos atuais: avisa o motivo e não mostra a conta", async () => {
    await dom.render(createElement(ClubValueCard, { ticker: "FLA3", name: "Flamengo", price: 4430, api: apiOf(fla3) }));
    await dom.settle();
    await dom.settle();
    await dom.type("#sim-pontos", "10");
    expect(dom.$("[data-testid=sim-erro]").textContent).toContain("20 pontos");
    expect(dom.$("[data-testid=sim-valor]")).toBeNull();
    expect(dom.$("#sim-pontos").className).toContain("err");
  });

  it("clube que já caiu da copa não ganha campo para ela, e campeonato fechado esconde pontos e colocação", async () => {
    const caiu: ClubValueView = { ...fla3, leagueOpen: false, cups: [{ ...fla3.cups[0]!, currentPhase: null }] };
    await dom.render(createElement(ClubValueCard, { ticker: "FLA3", name: "Flamengo", price: 4430, api: apiOf(caiu) }));
    await dom.settle();
    await dom.settle();
    expect(dom.$("#sim-copa-copa-do-brasil")).toBeNull();
    expect(dom.$("#sim-pontos")).toBeNull();
    expect(dom.text()).toContain("já caiu");
    expect(dom.text()).toContain("já foram pagos");
  });

  it("sem copa e sem pagamento: a conta fecha sem dividir por zero", async () => {
    const vazio: ClubValueView = { ...fla3, paid: 0, toReceive: 0, cups: [], points: 0, position: null };
    await dom.render(createElement(ClubValueCard, { ticker: "SPT3", name: "Santos", price: 1000, api: apiOf(vazio) }));
    await dom.settle();
    await dom.settle();
    expect(dom.text()).toContain("Santos não joga copa nesta temporada");
    await pick("#sim-colocacao", "20");
    expect(dom.$("[data-testid=sim-comparacao]").textContent).toContain("não há comparação");
  });

  it("a API falhando mostra um aviso calmo, sem derrubar a tela", async () => {
    const api = { dividends: vi.fn(async () => Promise.reject(new Error("fora"))) };
    await dom.render(createElement(ClubValueCard, { ticker: "FLA3", name: "Flamengo", price: 4430, api }));
    await dom.settle();
    await dom.settle();
    expect(dom.text()).toContain("Não foi possível carregar os dividendos");
  });

  it("não mostra o valor justo da casa, só a conta do jogador", async () => {
    await dom.render(createElement(ClubValueCard, { ticker: "FLA3", name: "Flamengo", price: 4430, api: apiOf(fla3) }));
    await dom.settle();
    await dom.settle();
    expect(dom.text()).toContain("Não é o valor justo da casa");
    expect(dom.text()).not.toMatch(/projeç|cotação da casa/i);
  });
});
