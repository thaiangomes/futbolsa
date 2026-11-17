// @vitest-environment jsdom
import type { ClubValueView } from "@futbolsa/contracts";
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import { ClubValueCard, outlookText } from "./club-value-card";
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
  played: 9,
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
      outcome: "playing" as const,
    },
    {
      competition: "libertadores",
      phases: ["grupos", "oitavas", "quartas", "semifinal", "final"],
      advance: { grupos: 150, oitavas: 225, quartas: 375, semifinal: 600 },
      title: 1200,
      currentPhase: "grupos",
      outcome: "playing" as const,
    },
  ],
};

const apiOf = (view: ClubValueView) => ({ dividends: vi.fn(async () => view) });

describe("modelo do simulador (o mesmo motor da API)", () => {
  it("livro 38: simulando 68 pontos, 3º lugar, queda nas quartas das duas copas: faltam R$ 14,35, recompra R$ 25,58, valor R$ 39,93, preço com downside de 10%", () => {
    const r = simulate(fla3, 4430, { points: "68", position: "3", cups: { "copa-do-brasil": "quartas", libertadores: "quartas" } });
    expect(r.ok).toBe(true);
    const s = r.ok ? r.result.simulation! : null;
    expect(s!.missing.total).toBe(1435);
    expect(s!.buyback).toBe(2558);
    expect(s!.value).toBe(3993);
    expect(s!.outlook).toEqual({ kind: "downside", percent: 10 });
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

  it("livro 38: simulando 68 pontos, 3º lugar, queda nas quartas das duas copas, faltam R$ 14,35, a recompra é R$ 25,58, o valor R$ 39,93 e o preço tem downside de 10%", async () => {
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
    expect(dom.$("[data-testid=sim-comparacao]").textContent).toBe("O preço agora (R$ 44,30) tem um downside de 10% até o preço da sua conta.");
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
    expect(dom.$("[data-testid=sim-comparacao]").textContent).toBe("O preço agora (R$ 30,00) tem um upside de 33% até o preço da sua conta.");
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
    const caiu: ClubValueView = { ...fla3, leagueOpen: false, cups: [{ ...fla3.cups[0]!, currentPhase: null, outcome: "eliminated" as const }] };
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

  it("livro 38: a frase mede a partir do preço, em upside e downside, com porcentagem inteira", () => {
    expect(outlookText(3622, { kind: "upside", percent: 270 })).toBe("O preço agora (R$ 36,22) tem um upside de 270% até o preço da sua conta.");
    expect(outlookText(15000, { kind: "downside", percent: 11 })).toBe("O preço agora (R$ 150,00) tem um downside de 11% até o preço da sua conta.");
    expect(outlookText(4000, { kind: "even", percent: 0 })).toBe("O preço agora está igual à sua conta.");
  });
});

describe("minha projeção no cartão (critérios 54 e 55)", () => {
  const dom = useDom();
  const pick = async (selector: string, value: string) => {
    const select = dom.$(selector) as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const salva = { ticker: "FLA3", points: 68, position: 3, cups: { "copa-do-brasil": "quartas", libertadores: "quartas" }, updatedAt: "2027-06-10T18:00:00.000Z" };
  const apiWith = (saved: typeof salva | null) => ({
    dividends: vi.fn(async () => fla3),
    projections: vi.fn(async () => ({ projections: saved ? [saved] : [] })),
    saveProjection: vi.fn(async (_t: string, body: object) => ({ ...salva, ...body })),
  });
  const abrir = async (api: ReturnType<typeof apiWith>, logged = true) => {
    await dom.render(createElement(ClubValueCard, { ticker: "FLA3", name: "Flamengo", price: 4430, api, logged }));
    await dom.settle();
    await dom.settle();
    await dom.settle();
  };

  it("livro 54: Salvar projeção manda só as premissas (pontos, colocação e a fase de cada copa)", async () => {
    const api = apiWith(null);
    await abrir(api);
    await dom.type("#sim-pontos", "68");
    await pick("#sim-colocacao", "3");
    await pick("#sim-copa-copa-do-brasil", "quartas");
    await pick("#sim-copa-libertadores", "quartas");
    await dom.click(dom.$("[data-testid=salvar-projecao]"));
    await dom.settle();
    expect(api.saveProjection).toHaveBeenCalledWith("FLA3", { points: 68, position: 3, cups: { "copa-do-brasil": "quartas", libertadores: "quartas" } });
    expect(dom.$("[data-testid=projecao-salva]")).not.toBeNull();
  });

  it("livro 54: ao reabrir, o cartão já vem com a projeção salva e o valor refeito (R$ 39,93)", async () => {
    await abrir(apiWith(salva));
    expect((dom.$("#sim-pontos") as HTMLInputElement).value).toBe("68");
    expect((dom.$("#sim-colocacao") as HTMLSelectElement).value).toBe("3");
    expect((dom.$("#sim-copa-copa-do-brasil") as HTMLSelectElement).value).toBe("quartas");
    expect(dom.$("[data-testid=sim-valor]").textContent).toBe("R$ 39,93");
    expect(dom.$("[data-testid=projecao-desatualizada]")).toBeNull();
  });

  it("livro 55: projeção que o clube já ultrapassou abre desatualizada, com o aviso, e salvar fica travado até revisar", async () => {
    await abrir(apiWith({ ...salva, points: 10 }));
    expect(dom.$("[data-testid=projecao-desatualizada]")).not.toBeNull();
    expect((dom.$("[data-testid=salvar-projecao]") as HTMLButtonElement).disabled).toBe(true);
    await dom.type("#sim-pontos", "30");
    expect((dom.$("[data-testid=salvar-projecao]") as HTMLButtonElement).disabled).toBe(false);
  });

  it("visitante não vê o botão e a API de projeções nem é chamada", async () => {
    const api = apiWith(null);
    await abrir(api, false);
    expect(dom.$("[data-testid=salvar-projecao]")).toBeNull();
    expect(api.projections).not.toHaveBeenCalled();
  });

  // O Vasco do print do Thaian: projeção salva quando o clube ainda estava na Sul-Americana; depois ele foi eliminado dela.
  const vasco: ClubValueView = {
    ...fla3,
    ticker: "VAS3",
    points: 35,
    position: 15,
    cups: [
      { ...fla3.cups[0]!, currentPhase: "semifinal", outcome: "playing" as const },
      {
        competition: "sulamericana",
        phases: ["grupos", "playoffs", "oitavas", "quartas", "semifinal", "final"],
        advance: { grupos: 100, playoffs: 150, oitavas: 200, quartas: 300, semifinal: 500 },
        title: 1000,
        currentPhase: null,
        outcome: "eliminated" as const,
      },
    ],
  };
  const salvaDoVasco = { ticker: "VAS3", points: 54, position: 9, cups: { "copa-do-brasil": "semifinal", sulamericana: "quartas" }, updatedAt: "2027-06-10T18:00:00.000Z" };

  it("livro 55: projeção salva com uma copa de que o clube já foi eliminado (Vasco na Sul-Americana) abre desatualizada, mas dá para revisar e salvar de novo", async () => {
    const api = {
      dividends: vi.fn(async () => vasco),
      projections: vi.fn(async () => ({ projections: [salvaDoVasco] })),
      saveProjection: vi.fn(async (_t: string, body: object) => ({ ...salvaDoVasco, ...body })),
    };
    await dom.render(createElement(ClubValueCard, { ticker: "VAS3", name: "Vasco da Gama", price: 4430, api, logged: true }));
    await dom.settle();
    await dom.settle();
    await dom.settle();
    // o cartão avisa que a projeção ficou desatualizada, e a Sul-Americana não tem campo (o clube já caiu dela)
    expect(dom.$("[data-testid=projecao-desatualizada]")).not.toBeNull();
    expect(dom.$("#sim-copa-sulamericana")).toBeNull();

    // o jogador revisa a aposta, como o aviso pede: a conta tem de funcionar e o botão de salvar, destravar
    await dom.type("#sim-pontos", "55");
    expect(dom.$("[data-testid=sim-erro]")?.textContent ?? null).toBeNull();
    expect((dom.$("[data-testid=salvar-projecao]") as HTMLButtonElement).disabled).toBe(false);

    // e o que se salva não leva a copa de que o clube já saiu
    await dom.click(dom.$("[data-testid=salvar-projecao]"));
    await dom.settle();
    expect(api.saveProjection).toHaveBeenCalledWith("VAS3", { points: 55, position: 9, cups: { "copa-do-brasil": "semifinal" } });
    expect(dom.$("[data-testid=projecao-salva]")).not.toBeNull();
  });

  it("falha ao salvar mostra aviso calmo", async () => {
    const api = apiWith(null);
    api.saveProjection.mockRejectedValueOnce(new Error("fora"));
    await abrir(api);
    await dom.click(dom.$("[data-testid=salvar-projecao]"));
    await dom.settle();
    expect(dom.$("[data-testid=projecao-erro]")).not.toBeNull();
  });
});
