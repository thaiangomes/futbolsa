import { describe, expect, it } from "vitest";
import {
  applyBuyback,
  applyPayout,
  BRASILEIRAO_A,
  BRASILEIRAO_B,
  computeStandings,
  scheduleBuyback,
  scheduleCupPayouts,
  scheduleLeaguePayouts,
  SULAMERICANA,
  type CupRules,
} from "../src/engine/dividends.js";
import { Ledger } from "../src/engine/ledger.js";
import type { Match } from "../src/engine/types.js";

let nextId = 1;
function game(
  round: number,
  kickoff: string,
  home: string,
  away: string,
  score: [number, number] | null,
  extra: Partial<Match> = {},
): Match {
  return {
    id: `m${nextId++}`,
    competition: "brasileirao-a",
    round,
    kickoff,
    home,
    away,
    homeGoals: score ? score[0] : null,
    awayGoals: score ? score[1] : null,
    status: score ? "finished" : "scheduled",
    ...extra,
  };
}

const t = (iso: string) => Date.parse(iso);
const END = (kickoff: string) => t(kickoff) + 2 * 3600 * 1000;

describe("scheduleLeaguePayouts", () => {
  it("paga R$ 0,10 por ponto só depois do último jogo da rodada", () => {
    const matches = [
      game(1, "2025-04-05T16:00:00-03:00", "FLA3", "PAL3", [2, 0]),
      game(1, "2025-04-06T18:30:00-03:00", "COR3", "SAO3", [1, 1]),
    ];
    const payouts = scheduleLeaguePayouts(matches, { perPoint: 10, placement: [] });
    const roundClose = END("2025-04-06T18:30:00-03:00");
    expect(payouts).toEqual([
      expect.objectContaining({ clubId: "COR3", perShare: 10, at: roundClose }),
      expect.objectContaining({ clubId: "FLA3", perShare: 30, at: roundClose }),
      expect.objectContaining({ clubId: "SAO3", perShare: 10, at: roundClose }),
    ]);
    // Quem perdeu não recebe nada.
    expect(payouts.find((p) => p.clubId === "PAL3")).toBeUndefined();
  });

  it("rodada com jogo ainda por disputar não paga", () => {
    const matches = [
      game(1, "2025-04-05T16:00:00-03:00", "FLA3", "PAL3", [2, 0]),
      game(1, "2025-04-06T18:30:00-03:00", "COR3", "SAO3", null),
    ];
    expect(scheduleLeaguePayouts(matches, BRASILEIRAO_A)).toEqual([]);
  });

  it("jogo adiado não segura a rodada e paga no fim da rodada em que for disputado", () => {
    const matches = [
      game(1, "2025-04-05T16:00:00-03:00", "FLA3", "PAL3", [1, 0]),
      // Adiado da rodada 1, disputado no meio da rodada 3.
      game(1, "2025-04-19T16:00:00-03:00", "COR3", "SAO3", [3, 0], { postponed: true }),
      game(2, "2025-04-12T16:00:00-03:00", "PAL3", "COR3", [0, 0]),
      game(2, "2025-04-13T16:00:00-03:00", "SAO3", "FLA3", [0, 2]),
      game(3, "2025-04-19T18:30:00-03:00", "FLA3", "COR3", [1, 1]),
      game(3, "2025-04-20T16:00:00-03:00", "PAL3", "SAO3", [2, 1]),
    ];
    const payouts = scheduleLeaguePayouts(matches, { perPoint: 10, placement: [] });

    const round1 = payouts.filter((p) => p.at === END("2025-04-05T16:00:00-03:00"));
    expect(round1.map((p) => p.clubId)).toEqual(["FLA3"]);

    // COR3 recebe os 3 pontos do jogo adiado + 1 da rodada 3, no fim da rodada 3.
    const round3Close = END("2025-04-20T16:00:00-03:00");
    const cor = payouts.find((p) => p.clubId === "COR3" && p.at === round3Close);
    expect(cor?.perShare).toBe(40);
  });

  it("título e colocação só pagam no fechamento da última rodada", () => {
    const matches = [
      game(1, "2025-04-05T16:00:00-03:00", "FLA3", "PAL3", [3, 0]),
      game(1, "2025-04-05T18:00:00-03:00", "COR3", "SAO3", [0, 1]),
      game(2, "2025-04-12T16:00:00-03:00", "PAL3", "COR3", [2, 0]),
      game(2, "2025-04-13T16:00:00-03:00", "SAO3", "FLA3", [1, 1]),
    ];
    const payouts = scheduleLeaguePayouts(matches, BRASILEIRAO_A);
    const placement = payouts.filter((p) => p.kind === "placement");
    const seasonClose = END("2025-04-13T16:00:00-03:00");
    expect(placement.every((p) => p.at === seasonClose)).toBe(true);
    // FLA3 4 pts (saldo +3), SAO3 4 pts (saldo +1), PAL3 3, COR3 0.
    expect(Object.fromEntries(placement.map((p) => [p.clubId, p.perShare]))).toEqual({
      FLA3: 500,
      SAO3: 450,
      PAL3: 400,
      COR3: 350,
    });
  });

  it("Série B paga metade por ponto", () => {
    const matches = [game(1, "2025-04-05T16:00:00-03:00", "SAN3", "CEA3", [2, 1], { competition: "brasileirao-b" })];
    const points = scheduleLeaguePayouts(matches, BRASILEIRAO_B).filter((p) => p.kind === "points");
    expect(points).toEqual([expect.objectContaining({ clubId: "SAN3", perShare: 15 })]);
  });
});

describe("computeStandings", () => {
  it("desempata por vitórias, saldo e gols pró", () => {
    const table = computeStandings([
      game(1, "2025-04-05T16:00:00-03:00", "A", "B", [3, 0]),
      game(1, "2025-04-05T16:00:00-03:00", "C", "D", [1, 0]),
    ]);
    expect(table.map((r) => r.clubId)).toEqual(["A", "C", "D", "B"]);
    expect(table[0]).toMatchObject({ points: 3, wins: 1, goalsFor: 3, goalsAgainst: 0 });
  });
});

describe("scheduleCupPayouts", () => {
  const rules: CupRules = {
    phases: ["quartas", "semifinal", "final"],
    advance: { quartas: 100, semifinal: 200 },
    title: 800,
  };
  const cup = (phase: string, kickoff: string, home: string, away: string, score: [number, number] | null, winner?: string): Match => ({
    ...game(0, kickoff, home, away, score),
    competition: "copa-do-brasil",
    round: undefined,
    phase,
    winner,
  });

  it("paga a fase só quando terminam todos os jogos dela (inclusive a volta)", () => {
    const matches = [
      cup("quartas", "2025-07-01T19:00:00-03:00", "A", "B", [1, 0]),
      cup("quartas", "2025-07-02T19:00:00-03:00", "C", "D", [0, 0]),
      cup("quartas", "2025-07-08T19:00:00-03:00", "B", "A", [1, 1], "A"),
      cup("quartas", "2025-07-09T21:30:00-03:00", "D", "C", [0, 2], "C"),
      cup("semifinal", "2025-08-01T19:00:00-03:00", "A", "C", null),
    ];
    const payouts = scheduleCupPayouts(matches, rules);
    expect(payouts.map((p) => [p.clubId, p.perShare, p.at])).toEqual([
      ["A", 100, END("2025-07-09T21:30:00-03:00")],
      ["C", 100, END("2025-07-09T21:30:00-03:00")],
    ]);
  });

  it("título paga no apito final da decisão", () => {
    const matches = [
      cup("semifinal", "2025-09-01T19:00:00-03:00", "A", "B", [2, 0], "A"),
      cup("semifinal", "2025-09-02T19:00:00-03:00", "C", "D", [0, 1], "D"),
      cup("final", "2025-10-01T19:00:00-03:00", "A", "D", [1, 0]),
      cup("final", "2025-10-08T19:00:00-03:00", "D", "A", [2, 0], "D"),
    ];
    const payouts = scheduleCupPayouts(matches, rules);
    expect(payouts.find((p) => p.kind === "cup-title")).toMatchObject({
      clubId: "D",
      perShare: 800,
      at: END("2025-10-08T19:00:00-03:00"),
    });
    expect(payouts.filter((p) => p.kind === "cup-phase").map((p) => p.clubId)).toEqual(["A", "D"]);
  });

  it("clube que entra direto numa fase não recebe pela fase anterior", () => {
    const matches = [
      cup("quartas", "2025-07-01T19:00:00-03:00", "A", "B", [1, 0], "A"),
      cup("semifinal", "2025-08-01T19:00:00-03:00", "A", "Z", null),
    ];
    const payouts = scheduleCupPayouts(matches, rules);
    expect(payouts.map((p) => p.clubId)).toEqual(["A"]);
  });

  it("Sul-Americana: chegar às oitavas vale R$ 0,60 pelos dois caminhos e quem cai fica com o que venceu", () => {
    // A ganha o grupo e vai direto às oitavas; B é segundo e passa dos playoffs;
    // D é segundo do outro grupo e cai nos playoffs para L, que veio da Libertadores.
    const matches = [
      cup("grupos", "2025-04-01T19:00:00-03:00", "A", "B", [2, 0]),
      cup("grupos", "2025-04-02T19:00:00-03:00", "D", "E", [1, 1]),
      cup("playoffs", "2025-07-15T19:00:00-03:00", "B", "X", [1, 0], "B"),
      cup("playoffs", "2025-07-16T19:00:00-03:00", "D", "L", [0, 1], "L"),
      cup("oitavas", "2025-08-12T19:00:00-03:00", "A", "L", null),
      cup("oitavas", "2025-08-13T19:00:00-03:00", "B", "Y", null),
    ].map((m) => ({ ...m, competition: "sul-americana" }));
    const payouts = scheduleCupPayouts(matches, SULAMERICANA);
    expect(payouts.map((p) => [p.clubId, p.perShare, p.detail])).toEqual([
      ["A", 60, "avançou da fase grupos"],
      ["B", 30, "avançou da fase grupos"],
      ["D", 30, "avançou da fase grupos"],
      ["B", 30, "avançou da fase playoffs"],
      ["L", 30, "avançou da fase playoffs"],
    ]);
  });
});

describe("applyPayout", () => {
  it("paga por ação a quem tem a ação no momento, inclusive presa em ordem, menos a tesouraria", () => {
    const ledger = new Ledger();
    ledger.open("ana", 0);
    ledger.open("bia", 0);
    ledger.open("tesouraria", 0);
    ledger.adjustShares("ana", "FLA3", 100);
    ledger.adjustShares("bia", "FLA3", 50);
    ledger.reserveShares("bia", "FLA3", 50);
    ledger.adjustShares("tesouraria", "FLA3", 1000);
    const total = applyPayout(
      ledger,
      { at: 0, clubId: "FLA3", perShare: 30, kind: "points", competition: "brasileirao-a", detail: "" },
      new Set(["tesouraria"]),
    );
    expect(total).toBe(4500);
    expect(ledger.get("ana").cash).toBe(3000);
    expect(ledger.get("bia").cash).toBe(1500);
    expect(ledger.get("tesouraria").cash).toBe(0);
  });
});

describe("recompra de fim de temporada", () => {
  const p = (at: number, clubId: string, perShare: number, competition = "brasileirao-a") => ({
    at, clubId, perShare, kind: "points" as const, competition, detail: "",
  });

  it("paga o múltiplo da soma dos dividendos de todas as competições, depois do último", () => {
    const payouts = [p(10, "FLA3", 30), p(20, "FLA3", 500), p(15, "FLA3", 800, "copa-do-brasil"), p(20, "PAL3", 40)];
    expect(scheduleBuyback(payouts, 2)).toEqual([
      expect.objectContaining({ clubId: "FLA3", perShare: 2 * 1330, at: 21, kind: "buyback" }),
      expect.objectContaining({ clubId: "PAL3", perShare: 80, at: 21, kind: "buyback" }),
    ]);
    expect(scheduleBuyback(payouts, 0)).toEqual([]);
  });

  it("paga os acionistas, menos a tesouraria, e zera as ações de todos", () => {
    const ledger = new Ledger();
    ledger.open("ana", 0);
    ledger.open("tesouraria", 0);
    ledger.adjustShares("ana", "FLA3", 100);
    ledger.adjustShares("tesouraria", "FLA3", 1000);
    const total = applyBuyback(
      ledger,
      { at: 0, clubId: "FLA3", perShare: 600, kind: "buyback", competition: "temporada", detail: "" },
      new Set(["tesouraria"]),
    );
    expect(total).toBe(60000);
    expect(ledger.get("ana").cash).toBe(60000);
    expect(ledger.get("tesouraria").cash).toBe(0);
    expect(ledger.totalShares("FLA3")).toBe(0);
  });
});
