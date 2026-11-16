// @vitest-environment jsdom
import type { CompetitionMatch, CompetitionView } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import { CompetitionsContent } from "./competitions-screen";
import { currentStageIndex, decidedOnPenalties, tabFromSearch } from "./model";

// Item 11 da fila da partida de teste: a página das competições (Livro, critério 52).

const club = (ticker: string | null, name: string) => ({ ticker, name });
const match = (over: Partial<CompetitionMatch> = {}): CompetitionMatch => ({
  kickoff: "2027-04-18T19:00:00.000Z",
  status: "scheduled",
  home: club("FLA3", "Flamengo"),
  away: club("PAL3", "Palmeiras"),
  homeGoals: null,
  awayGoals: null,
  advanced: null,
  inPlay: false,
  ...over,
});
const league: CompetitionView = {
  competition: "brasileirao-a",
  standings: [
    { position: 1, club: club("FLA3", "Flamengo"), points: 4, played: 2, wins: 1, draws: 1, losses: 0, goalDiff: 2 },
    { position: 2, club: club("PAL3", "Palmeiras"), points: 0, played: 1, wins: 0, draws: 0, losses: 1, goalDiff: -2 },
  ],
  stages: [
    { round: 1, phase: null, matches: [match({ status: "finished", homeGoals: 2, awayGoals: 0 })], ties: [] },
    { round: 2, phase: null, matches: [match({ home: club("COR3", "Corinthians"), away: club(null, "Clube de Fora") })], ties: [] },
  ],
};
const oitavas = match({ status: "finished", homeGoals: 1, awayGoals: 1, advanced: "away" });
const ida = match({ home: club("COR3", "Corinthians"), away: club("SPT3", "Santos"), status: "finished", homeGoals: 2, awayGoals: 0 });
const volta = match({ home: club("SPT3", "Santos"), away: club("COR3", "Corinthians"), status: "finished", homeGoals: 1, awayGoals: 0 });
const cup: CompetitionView = {
  competition: "copa-do-brasil",
  standings: [],
  stages: [
    { round: null, phase: "oitavas", matches: [oitavas], ties: [{ home: club("FLA3", "Flamengo"), away: club("PAL3", "Palmeiras"), legs: [{ leg: "unico", match: oitavas }], aggregate: { home: 1, away: 1 }, advanced: "away", penalties: true }] },
    { round: null, phase: "quartas", matches: [ida, volta], ties: [{ home: club("COR3", "Corinthians"), away: club("SPT3", "Santos"), legs: [{ leg: "ida", match: ida }, { leg: "volta", match: volta }], aggregate: { home: 2, away: 1 }, advanced: "home", penalties: false }] },
  ],
};
const api = () => ({ competition: vi.fn(async (c: CompetitionView["competition"]): Promise<CompetitionView> => (c === "copa-do-brasil" ? cup : c === "brasileirao-a" ? league : { competition: c, standings: [], stages: [] })) });

describe("página das competições", () => {
  const dom = useDom();
  const open = async () => {
    const a = api();
    await dom.render(createElement(CompetitionsContent, { api: a }));
    await dom.settle();
    await dom.settle();
    return a;
  };

  it("livro 52: uma aba por competição, e a Série A abre com a classificação (com selo e link) e a rodada em andamento", async () => {
    const a = await open();
    expect(dom.$$("[role=tab]").map((t) => t.textContent)).toEqual(["Série A", "Série B", "Copa do Brasil", "Libertadores", "Sul-Americana"]);
    expect(a.competition).toHaveBeenCalledWith("brasileirao-a");
    const linhas = dom.$$("[data-testid=linha-classificacao]");
    expect(linhas).toHaveLength(2);
    expect(linhas[0]!.textContent).toContain("Flamengo");
    expect(linhas[0]!.querySelector("[data-testid=selo]")).not.toBeNull();
    expect(linhas[0]!.querySelector("a")!.getAttribute("href")).toBe("/clube?t=FLA3");
    // a rodada 1 acabou: abre a 2, a primeira com jogo por acontecer; clube de fora sem link
    expect(dom.$("[data-testid=rodada]").textContent).toContain("Rodada 2");
    const confronto = dom.$("[data-testid=confronto]");
    expect(confronto.textContent).toContain("Clube de Fora");
    expect(confronto.querySelectorAll("a")).toHaveLength(1);
  });

  it("as setas passam as rodadas e mostram o placar do jogo encerrado", async () => {
    await open();
    await dom.click(dom.$("[aria-label='Rodada anterior']"));
    expect(dom.$("[data-testid=rodada]").textContent).toContain("Rodada 1");
    expect(dom.$("[data-testid=placar]").textContent).toBe("2 × 0");
    expect((dom.$("[aria-label='Rodada anterior']") as HTMLButtonElement).disabled).toBe(true);
  });

  it("na copa: uma fase por vez, abrindo na fase atual, com as fases numa fileira; quem passou nos pênaltis e o jogo em andamento", async () => {
    await open();
    await dom.click(dom.$$("[role=tab]")[2]!);
    await dom.settle();
    await dom.settle();
    expect(dom.$("[data-testid=classificacao]")).toBeNull();
    // as oitavas acabaram; as quartas têm jogo por acontecer: abre nelas, marcadas como a fase atual
    expect(dom.$$("[data-testid=fases] button").map((b) => b.textContent)).toEqual(["Oitavas", "Quartas"]);
    expect(dom.$$("[data-testid=fase]")).toHaveLength(1);
    expect(dom.$("[data-testid=fase] h2").textContent).toBe("Quartas · fase atual");
    expect(dom.$("[data-atual=true]").textContent).toContain("Quartas");
    // o confronto das quartas: ida e volta com o placar de cada jogo, o agregado e quem passou (sem pênaltis)
    expect(dom.$$("[data-testid=jogo-do-confronto]").map((j) => j.textContent)).toEqual(["IdaCorinthians 2 × 0 Santos", "VoltaSantos 1 × 0 Corinthians"]);
    expect(dom.$("[data-testid=agregado]").textContent).toBe("2 × 1");
    expect(dom.$("[data-testid=passou-confronto]").textContent).toBe("Passou: Corinthians");
    // escolhendo as oitavas: o resultado nos pênaltis; a fase atual continua marcada
    await dom.click(dom.$$("[data-testid=fases] button")[0]!);
    expect(dom.$("[data-testid=fase] h2").textContent).toBe("Oitavas");
    expect(dom.$$("[data-testid=jogo-do-confronto]").map((j) => j.textContent)).toEqual(["Jogo únicoFlamengo 1 × 1 Palmeiras"]);
    expect(dom.$("[data-testid=passou-confronto]").textContent).toBe("Passou: Palmeiras · decidido nos pênaltis");
    expect(dom.$("[data-atual=true]").textContent).toContain("Quartas");
    // as setas
    await dom.click(dom.$("[aria-label='Próxima fase']"));
    expect(dom.$("[data-testid=fase] h2").textContent).toBe("Quartas · fase atual");
    expect((dom.$("[aria-label='Próxima fase']") as HTMLButtonElement).disabled).toBe(true);
  });

  it("competição sem jogos avisa, em vez de mostrar uma página vazia", async () => {
    await open();
    await dom.click(dom.$$("[role=tab]")[3]!);
    await dom.settle();
    await dom.settle();
    expect(dom.$("[data-testid=sem-jogos]").textContent).toContain("ainda não tem jogos");
  });
});

describe("regras da página", () => {
  it("a aba vem da query e uma desconhecida cai na Série A", () => {
    expect(tabFromSearch("?c=libertadores")).toBe("libertadores");
    expect(tabFromSearch("?c=nada")).toBe("brasileirao-a");
    expect(tabFromSearch("")).toBe("brasileirao-a");
  });

  it("a rodada aberta é a primeira com jogo por acontecer, ou a última quando todas acabaram", () => {
    const done = (r: number) => ({ round: r, phase: null, matches: [match({ status: "finished" })], ties: [] });
    const open = (r: number) => ({ round: r, phase: null, matches: [match()], ties: [] });
    expect(currentStageIndex([done(1), open(2), open(3)])).toBe(1);
    expect(currentStageIndex([done(1), done(2)])).toBe(1);
    expect(currentStageIndex([])).toBe(0);
  });

  it("decidido nos pênaltis: empate com alguém que passou", () => {
    expect(decidedOnPenalties({ status: "finished", homeGoals: 1, awayGoals: 1, advanced: "home" })).toBe(true);
    expect(decidedOnPenalties({ status: "finished", homeGoals: 2, awayGoals: 1, advanced: "home" })).toBe(false);
    expect(decidedOnPenalties({ status: "scheduled", homeGoals: null, awayGoals: null, advanced: null })).toBe(false);
  });
});
