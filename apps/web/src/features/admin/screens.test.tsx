// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeProvider } from "../../realtime/react";
import type { AdminApi } from "./api";
import { MatchesScreen } from "./matches-screen";
import { SeasonScreen } from "./season-screen";
import { StandingsScreen } from "./standings-screen";
import { SuspensionScreen } from "./suspension-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fakeClient = () => ({
  connect: () => undefined,
  disconnect: () => undefined,
  reconnect: () => undefined,
  subscribe: () => () => undefined,
  getState: () => ({ status: "idle" as const, retryInMs: null, role: "visitor" as const }),
  onState: () => () => undefined,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(element: ReactElement) {
  await act(async () => root.render(createElement(RealtimeProvider, { createClient: fakeClient as never, children: element })));
}
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector(selector) as T;
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
async function type(selector: string, value: string) {
  const input = $<HTMLInputElement>(selector);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}
const fake = (overrides: Partial<Record<keyof AdminApi, unknown>>) => overrides as unknown as AdminApi;

const club = (id: number, ticker: string | null, name: string) => ({ id, ticker, name });

describe("suspensão (tela)", () => {
  it("admin 23: o botão só liga com o motivo e, para um clube, com o ticker; o motivo vai para a API", async () => {
    const suspend = vi.fn(async () => ({ market: null, clubs: [] }));
    const admin = fake({ suspensions: async () => ({ market: null, clubs: [] }), suspend });
    await render(createElement(SuspensionScreen, { admin }));
    expect(button("Suspender").disabled).toBe(true);
    await type("#ticker", "FLA3");
    expect(button("Suspender").disabled).toBe(true);
    await type("#motivo", "estádio interditado");
    expect(button("Suspender").disabled).toBe(false);
    await click(button("Suspender"));
    expect(suspend).toHaveBeenCalledWith("estádio interditado", "FLA3");
  });

  it("mostra quem está suspenso e deixa retomar", async () => {
    const resume = vi.fn(async () => ({ market: null, clubs: [] }));
    const admin = fake({ suspensions: async () => ({ market: { reason: "falha na fonte" }, clubs: [{ ticker: "FLA3", reason: "estádio" }] }), resume });
    await render(createElement(SuspensionScreen, { admin }));
    expect(text()).toContain("falha na fonte");
    await click(button("Retomar FLA3"));
    expect(resume).toHaveBeenCalledWith("FLA3");
  });
});

describe("jogos (tela)", () => {
  const match = {
    id: 7, seasonId: 1, competition: "brasileirao-a" as const, round: 4, phase: null, home: club(1, "FLA3", "Flamengo"), away: club(2, "PAL3", "Palmeiras"),
    kickoff: "2027-04-10T21:00:00.000Z", finishedAt: null, homeGoals: 2, awayGoals: 0, advancedClubId: null, status: "finished" as const, outOfWindow: false,
    source: "espn", manualOverride: true, sourceView: { status: "finished" as const, homeGoals: 1, awayGoals: 1, kickoff: "2027-04-10T21:00:00.000Z", fetchedAt: "2027-04-11T00:00:00.000Z" }, diverges: true,
  };
  const pending = { matches: [], blocked: [], lastImports: { "brasileirao-a": null } };

  it("admin 6: a divergência da fonte aparece no jogo editado à mão", async () => {
    const admin = fake({ pending: async () => pending, matches: async () => ({ matches: [match] }) });
    await render(createElement(MatchesScreen, { admin }));
    expect(text()).toContain("fonte: 1 × 1");
  });

  it("admin 33: o formulário não envia sem motivo, e com motivo manda o placar", async () => {
    const patchMatch = vi.fn(async () => match);
    const admin = fake({ pending: async () => pending, matches: async () => ({ matches: [match] }), patchMatch });
    await render(createElement(MatchesScreen, { admin }));
    await click(button("Editar"));
    await type("#g-h-7", "3");
    expect(button("Salvar").disabled).toBe(true);
    await type("#motivo-7", "placar errado na importação");
    expect(button("Salvar").disabled).toBe(false);
    await click(button("Salvar"));
    expect(patchMatch).toHaveBeenCalledWith(7, { reason: "placar errado na importação", status: "finished", homeGoals: 3, awayGoals: 0 });
  });

  it("jogo encerrado pede os dois gols", async () => {
    const admin = fake({ pending: async () => pending, matches: async () => ({ matches: [{ ...match, homeGoals: null, awayGoals: null, status: "scheduled" as const, diverges: false, sourceView: null }] }) });
    await render(createElement(MatchesScreen, { admin }));
    await click(button("Editar"));
    await type("#g-h-7", "1");
    await type("#motivo-7", "preenchi o placar");
    expect(text()).toContain("Informe o placar dos dois clubes.");
    expect(button("Salvar").disabled).toBe(true);
  });

  it("a pendência mostra a rodada que o jogo impede de fechar", async () => {
    const admin = fake({
      pending: async () => ({
        matches: [{ matchId: 1, competition: "sulamericana" as const, round: null, phase: "oitavas", homeTicker: "FLA3", homeName: "Flamengo", awayTicker: null, awayName: "Lanús", kickoff: "2027-07-10T20:00:00.000Z", expectedEnd: "2027-07-10T22:00:00.000Z" }],
        blocked: [{ competition: "sulamericana" as const, round: null, phase: "oitavas", matchIds: [1] }],
        lastImports: {},
      }),
      matches: async () => ({ matches: [] }),
    });
    await render(createElement(MatchesScreen, { admin }));
    expect(text()).toContain("Não fecha: Sul-Americana, oitavas");
  });
});

describe("classificação (tela)", () => {
  const view = (confirmedAt: string | null, qualificationBonus = false) => ({
    competition: "brasileirao-a" as const,
    rows: [
      { club: club(1, "FLA3", "Flamengo"), position: 1, points: 70, sourcePosition: 1, libertadores: false, sulamericana: false },
      { club: club(2, "PAL3", "Palmeiras"), position: 2, points: 69, sourcePosition: 2, libertadores: false, sulamericana: false },
    ],
    manualOverride: false,
    confirmedBy: confirmedAt ? "chefe" : null,
    confirmedAt,
    qualificationBonus,
  });
  const select = async (label: string, value: string) => {
    const el = $<HTMLSelectElement>(`[aria-label="${label}"]`);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("com bônus de classificação, o admin marca os classificados (quem está nas duas fica nas duas listas) e a API recebe os ids", async () => {
    const putQualified = vi.fn(async () => view(null, true));
    const admin = fake({ standings: async () => ({ standings: [view(null, true)] }), putQualified });
    await render(createElement(StandingsScreen, { admin }));
    expect(button("Salvar os classificados").disabled).toBe(true);
    await select("Vaga de Flamengo", "3");
    await select("Vaga de Palmeiras", "2");
    expect(button("Salvar os classificados").disabled).toBe(false);
    // com a marcação por salvar, conferir fica desligado (a marcação tira a conferência)
    expect(button("Conferir").disabled).toBe(true);
    await click(button("Salvar os classificados"));
    expect(putQualified).toHaveBeenCalledWith({ libertadores: [1], sulamericana: [1, 2] });
  });

  it("sem bônus de classificação na temporada, a tela não pede a marcação", async () => {
    const admin = fake({ standings: async () => ({ standings: [view(null, false)] }) });
    await render(createElement(StandingsScreen, { admin }));
    expect(container.querySelector('[aria-label="Vaga de Flamengo"]')).toBeNull();
    expect(text()).not.toContain("Salvar os classificados");
  });

  it("subir um clube pede motivo antes de salvar a correção", async () => {
    const correct = vi.fn(async () => view(null));
    const admin = fake({ standings: async () => ({ standings: [view(null)] }), correctStandings: correct });
    await render(createElement(StandingsScreen, { admin }));
    await click(container.querySelector('[aria-label="Subir Palmeiras"]')!);
    expect(button("Salvar a correção").disabled).toBe(true);
    await type("#motivo-brasileirao-a", "a fonte trocou os dois");
    await click(button("Salvar a correção"));
    expect(correct).toHaveBeenCalledWith("brasileirao-a", [2, 1], "a fonte trocou os dois");
  });

  it("conferir liga com a tabela sem alteração", async () => {
    const confirm = vi.fn(async () => view("2027-04-01T13:00:00.000Z"));
    const admin = fake({ standings: async () => ({ standings: [view(null)] }), confirmStandings: confirm });
    await render(createElement(StandingsScreen, { admin }));
    await click(button("Conferir"));
    expect(confirm).toHaveBeenCalledWith("brasileirao-a");
  });
});

describe("preparar a temporada (tela)", () => {
  const season = { id: 3, year: 2027, status: "preparing" as const, offerSize: 1000, firstKickoff: null, ipoOpensAt: null, ipoClosesAt: null, tradingOpensAt: null, suspendedReason: null };
  const cup = (violations: Array<{ code: string; message: string }>) => ({
    competition: "libertadores" as const,
    phases: [{ phaseKey: "semifinal", variant: "advance", perShare: 100 }, { phaseKey: "final", variant: "title", perShare: 800 }],
    violations,
    phasesWithoutValue: [],
    confirmedBy: null,
    confirmedAt: null,
  });
  const rules = {
    aPerPoint: 10, bPerPoint: 5, aPlacement: [1000, 700], aLibertadoresBonus: 300, aSulamericanaBonus: 100, aRelegationPenalty: 100, aRelegationSlots: 4, promotionPerShare: 200, promotionSlots: 4, buybackMultipleBp: 15000, lockedAt: null,
  };
  const base = (cups: ReturnType<typeof cup>[], overrides: Partial<Record<keyof AdminApi, unknown>> = {}) =>
    fake({
      currentSeason: async () => ({ season, clubs: [] }),
      knownClubs: async () => ({ clubs: [] }),
      rules: async () => ({ rules, cups }),
      ...overrides,
    });

  it("dividendos 28: os avisos da tabela aparecem e não bloqueiam a confirmação", async () => {
    const confirmCup = vi.fn(async () => cup([]));
    const admin = base([cup([{ code: "not_increasing", message: "O valor da semifinal não cresce." }])], { confirmCup });
    await render(createElement(SeasonScreen, { admin }));
    expect(text()).toContain("O valor da semifinal não cresce.");
    expect(button("Confirmar a tabela").disabled).toBe(false);
    await click(button("Confirmar a tabela"));
    expect(confirmCup).toHaveBeenCalledWith(3, "libertadores");
  });

  it("os valores das ligas (por ponto, colocação, classificação e penalização) se editam e vão para a API", async () => {
    const putRules = vi.fn(async () => rules);
    const admin = base([cup([])], { putRules });
    await render(createElement(SeasonScreen, { admin }));
    expect(button("Salvar os valores").disabled).toBe(true);
    expect($<HTMLInputElement>("#bonus-libertadores").value).toBe("300");
    expect($<HTMLInputElement>("#penalizacao").value).toBe("100");
    await type("#penalizacao", "200");
    await type("#bonus-sulamericana", "150");
    await type('[aria-label="Colocação 1º"]', "1200");
    expect(button("Salvar os valores").disabled).toBe(false);
    await click(button("Salvar os valores"));
    expect(putRules).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ aPlacement: [1200, 700], aLibertadoresBonus: 300, aSulamericanaBonus: 150, aRelegationPenalty: 200, aRelegationSlots: 4, buybackMultipleBp: 15000 }),
    );
  });

  it("valor inválido (vazio ou com letra) desliga o salvar dos valores das ligas", async () => {
    await render(createElement(SeasonScreen, { admin: base([cup([])]) }));
    await type("#rebaixados", "21");
    expect(button("Salvar os valores").disabled).toBe(true);
    await type("#rebaixados", "4");
    await type("#acesso", "2,00");
    expect(button("Salvar os valores").disabled).toBe(true);
  });

  it("depois da abertura do IPO os valores das ligas também ficam travados", async () => {
    const admin = base([cup([])], { rules: async () => ({ rules: { ...rules, lockedAt: "2027-03-01T12:00:00.000Z" }, cups: [cup([])] }) });
    await render(createElement(SeasonScreen, { admin }));
    expect($<HTMLInputElement>("#penalizacao").disabled).toBe(true);
    expect($<HTMLInputElement>("#a-por-ponto").disabled).toBe(true);
    expect($<HTMLInputElement>('[aria-label="Colocação 2º"]').disabled).toBe(true);
    expect(button("Salvar os valores").disabled).toBe(true);
  });

  it("depois da abertura do IPO a oferta e as tabelas não se editam", async () => {
    const admin = base([cup([])], { currentSeason: async () => ({ season: { ...season, status: "ipo_open" as const }, clubs: [] }), rules: async () => ({ rules: { ...rules, lockedAt: "2027-03-01T12:00:00.000Z" }, cups: [cup([])] }) });
    await render(createElement(SeasonScreen, { admin }));
    expect(text()).toContain("O IPO já abriu");
    expect($<HTMLInputElement>("#oferta").disabled).toBe(true);
    expect(button("Confirmar a tabela").disabled).toBe(true);
  });

  it("sem temporada em andamento, oferece criar a próxima", async () => {
    const createSeason = vi.fn(async () => season);
    const admin = fake({ currentSeason: async () => ({ season: null, clubs: [] }), knownClubs: async () => ({ clubs: [] }), rules: async () => null, createSeason });
    await render(createElement(SeasonScreen, { admin }));
    await type("#ano", "2028");
    await click(button("Criar a temporada"));
    expect(createSeason).toHaveBeenCalledWith(2028);
  });
});
