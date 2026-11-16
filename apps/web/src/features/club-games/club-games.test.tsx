// @vitest-environment jsdom
import type { ClubFixtures, ClubValueView, Fixture } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import { SituationCard } from "../club-value/situation-card";
import { competitionName, formatKickoff, formatKickoffShort, stageText } from "./format";
import { NextGamesCard } from "./fixtures-card";

// Itens 9 e 10 da fila da partida de teste: os próximos jogos e a situação do clube nas competições.

const fixture = (over: Partial<Fixture> = {}): Fixture => ({
  kickoff: "2027-04-18T19:00:00.000Z",
  competition: "brasileirao-a",
  round: 12,
  phase: null,
  home: true,
  opponent: { ticker: "PAL3", name: "Palmeiras" },
  inPlay: false,
  ...over,
});
const api = (fixtures: Fixture[]) => ({ fixtures: vi.fn(async (): Promise<ClubFixtures> => ({ ticker: "FLA3", fixtures })) });

describe("formatos dos jogos", () => {
  it("a data e a hora são as de Brasília (19h UTC é 16h)", () => {
    expect(formatKickoff("2027-04-18T19:00:00.000Z")).toBe("dom. 18/04, 16h00");
    expect(formatKickoffShort("2027-04-18T19:00:00.000Z")).toBe("18/04 16h00");
    // meia-noite de Brasília não vira "24h"
    expect(formatKickoff("2027-04-19T03:00:00.000Z")).toBe("dom. 18/04, 00h00".replace("dom. 18/04", "seg. 19/04"));
  });

  it("competição, rodada e fase", () => {
    expect(competitionName("brasileirao-a")).toBe("Brasileirão");
    expect(competitionName("brasileirao-b")).toBe("Série B");
    expect(competitionName("sulamericana")).toBe("Sul-Americana");
    expect(stageText({ round: 12, phase: null })).toBe("Rodada 12");
    expect(stageText({ round: null, phase: "oitavas" })).toBe("Oitavas");
    expect(stageText({ round: null, phase: "grupos" })).toBe("Fase de grupos");
    expect(stageText({ round: null, phase: null })).toBeNull();
  });
});

describe("cartão Próximos jogos", () => {
  const dom = useDom();
  const open = async (fixtures: Fixture[]) => {
    const a = api(fixtures);
    await dom.render(createElement(NextGamesCard, { ticker: "FLA3", api: a }));
    await dom.settle();
    await dom.settle();
    return a;
  };

  it("livro 50: lista data e hora de Brasília, mando, adversário com selo, competição e rodada ou fase", async () => {
    const a = await open([
      fixture(),
      fixture({ kickoff: "2027-04-22T22:00:00.000Z", competition: "libertadores", round: null, phase: "grupos", home: false, opponent: { ticker: "COR3", name: "Corinthians" } }),
    ]);
    expect(a.fixtures).toHaveBeenCalledWith("FLA3");
    const jogos = dom.$$("[data-testid=jogo]");
    expect(jogos).toHaveLength(2);
    expect(jogos[0]!.textContent).toContain("Em casa · Palmeiras");
    expect(jogos[0]!.textContent).toContain("Brasileirão · Rodada 12");
    expect(jogos[0]!.textContent).toContain("dom. 18/04, 16h00");
    expect(jogos[1]!.textContent).toContain("Fora · Corinthians");
    expect(jogos[1]!.textContent).toContain("Libertadores · Fase de grupos");
    expect(jogos[0]!.querySelector("[data-testid=selo]")!.getAttribute("aria-label")).toBe("Selo PAL3, Palmeiras");
  });

  it("o jogo que já começou aparece como \"Em jogo agora\", no lugar da data", async () => {
    await open([fixture({ inPlay: true })]);
    expect(dom.$("[data-testid=em-jogo]").textContent).toContain("Em jogo agora");
    expect(dom.$("[data-testid=quando]")).toBeNull();
  });

  it("adversário de fora da lista aparece só pelo nome, com selo neutro", async () => {
    await open([fixture({ competition: "sulamericana", round: null, phase: "oitavas", opponent: { ticker: null, name: "Clube de Fora" } })]);
    expect(dom.$("[data-testid=adversario]").textContent).toContain("Clube de Fora");
    expect(dom.$("[data-testid=selo]").getAttribute("aria-label")).toBe("Selo Clube de Fora");
    expect(dom.$("[data-testid=selo]").getAttribute("data-pattern")).toBe("solido");
  });

  it("mostra no máximo cinco jogos; sem jogo agendado, avisa; com a API falhando, aviso calmo", async () => {
    await open(Array.from({ length: 8 }, (_, i) => fixture({ kickoff: `2027-04-${20 + i}T19:00:00.000Z`, round: i + 1 })));
    expect(dom.$$("[data-testid=jogo]")).toHaveLength(5);
    await open([]);
    expect(dom.$("[data-testid=sem-jogos]").textContent).toContain("Nenhum jogo agendado");
    const falha = { fixtures: vi.fn(async () => Promise.reject(new Error("fora"))) };
    await dom.render(createElement(NextGamesCard, { ticker: "FLA3", api: falha }));
    await dom.settle();
    await dom.settle();
    expect(dom.text()).toContain("Não foi possível carregar os jogos");
  });
});

describe("cartão Situação nas competições", () => {
  const dom = useDom();
  const view = (over: Partial<ClubValueView> = {}): ClubValueView => ({
    ticker: "FLA3",
    league: "brasileirao-a",
    leagueRules: { perPoint: 10, placement: [500] },
    leagueOpen: true,
    points: 20,
    position: 5,
    played: 9,
    paid: 270,
    toReceive: 30,
    buybackMultipleBp: 15_000,
    cups: [
      { competition: "copa-do-brasil", phases: ["oitavas", "quartas"], advance: { oitavas: 150 }, title: 800, currentPhase: "oitavas", outcome: "playing" },
      { competition: "libertadores", phases: ["grupos", "oitavas"], advance: { grupos: 150 }, title: 1200, currentPhase: null, outcome: "eliminated" },
      { competition: "sulamericana", phases: ["grupos", "oitavas"], advance: { grupos: 60 }, title: 480, currentPhase: null, outcome: "champion" },
    ],
    ...over,
  });
  const show = async (v: ClubValueView) => {
    await dom.render(createElement(SituationCard, { view: v }));
  };

  it("livro 51: mostra a colocação, os pontos e os jogos no Brasileirão e a situação em cada copa: disputando, eliminado ou campeão", async () => {
    await show(view());
    expect(dom.$("[data-testid=situacao-liga]").textContent).toContain("Brasileirão · Série A");
    expect(dom.$("[data-testid=situacao-liga]").textContent).toContain("5º lugar · 20 pontos · 9 jogos");
    const copas = Object.fromEntries(dom.$$("[data-testid=situacao-copa]").map((c) => [c.getAttribute("data-competition"), c.textContent]));
    expect(copas["copa-do-brasil"]).toContain("Disputando: nas oitavas");
    expect(copas.libertadores).toContain("Eliminado");
    expect(copas.sulamericana).toContain("Campeão");
  });

  it("Série B e começo de temporada: sem jogos ainda, sem colocação; clube sem copa diz que não disputa", async () => {
    await show(view({ league: "brasileirao-b", points: 0, position: null, played: 0, cups: [] }));
    expect(dom.$("[data-testid=situacao-liga]").textContent).toContain("Série B");
    expect(dom.$("[data-testid=situacao-liga]").textContent).toContain("ainda sem jogos");
    expect(dom.text()).toContain("não disputa copas nesta temporada");
  });

  it("um ponto e um jogo no singular", async () => {
    await show(view({ points: 1, played: 1, cups: [] }));
    expect(dom.$("[data-testid=situacao-liga]").textContent).toContain("1 ponto · 1 jogo");
  });
});
