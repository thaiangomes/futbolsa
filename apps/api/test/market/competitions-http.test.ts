import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { competitionViewSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { clubs, matches, standings } from "../../src/infra/db/schema/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { marketSeason, type MarketSeason } from "./helpers.js";

// Item 11 da fila da partida de teste: a página das competições. GET /competitions/:competition (pública).

describe("competições (HTTP)", () => {
  const database = useTestDatabase(8);
  // 2027-06-10 15h de Brasília
  const clock = new FixedClock(new Date("2027-06-10T18:00:00Z"));
  let app: NestFastifyApplication;
  let s: MarketSeason;

  const get = (url: string) => app.inject({ method: "GET", url });
  const id = (t: string) => s.clubIds.get(t)!;
  const jogo = (competition: string, home: string, away: string, kickoff: string, over: Partial<typeof matches.$inferInsert> = {}) => ({
    seasonId: s.seasonId,
    competition,
    round: competition.startsWith("brasileirao") ? 1 : null,
    phase: competition.startsWith("brasileirao") ? null : "oitavas",
    homeClubId: id(home),
    awayClubId: id(away),
    kickoff: new Date(kickoff),
    ...over,
  });

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    const [fora] = await database.db.insert(clubs).values({ name: "Clube de Fora" }).returning({ id: clubs.id });
    await database.db.insert(matches).values([
      jogo("brasileirao-a", "FLA3", "PAL3", "2027-06-01T19:00:00Z", { status: "finished", homeGoals: 2, awayGoals: 0 }),
      jogo("brasileirao-a", "COR3", "FLA3", "2027-06-08T19:00:00Z", { status: "finished", homeGoals: 1, awayGoals: 1, round: 2 }),
      jogo("brasileirao-a", "PAL3", "COR3", "2027-06-13T19:00:00Z", { round: 3 }),
      jogo("brasileirao-a", "FLA3", "SPT3", "2027-06-10T17:00:00Z", { round: 3 }),
      // as copas: oitavas com pênaltis (placar empatado e quem passou), e uma fase com clube de fora da lista
      jogo("copa-do-brasil", "FLA3", "PAL3", "2027-06-02T22:00:00Z", { status: "finished", homeGoals: 1, awayGoals: 1, advancedClubId: id("PAL3") }),
      { ...jogo("copa-do-brasil", "COR3", "SPT3", "2027-06-04T22:00:00Z"), phase: "quartas", awayClubId: fora!.id },
      jogo("copa-do-brasil", "COR3", "SPT3", "2027-06-03T22:00:00Z", { phase: "1a-fase", status: "finished", homeGoals: 3, awayGoals: 0, advancedClubId: id("COR3") }),
      jogo("libertadores", "COR3", "PAL3", "2027-06-18T22:00:00Z"),
    ]);
    await database.db.insert(standings).values([
      { seasonId: s.seasonId, competition: "brasileirao-a", clubId: id("FLA3"), position: 1, points: 4 },
      { seasonId: s.seasonId, competition: "brasileirao-a", clubId: id("COR3"), position: 2, points: 1 },
      { seasonId: s.seasonId, competition: "brasileirao-a", clubId: id("PAL3"), position: 3, points: 0 },
    ]);
  });
  afterAll(() => app.close());

  it("livro 52: é pública e devolve a classificação (posição, pontos, jogos, vitórias, empates, derrotas e saldo) e as rodadas em ordem", async () => {
    const res = await get("/competitions/brasileirao-a");
    expect(res.statusCode).toBe(200);
    const view = competitionViewSchema.parse(res.json());
    expect(view.standings.map((r) => [r.position, r.club.ticker, r.points, r.played, r.wins, r.draws, r.losses, r.goalDiff])).toEqual([
      [1, "FLA3", 4, 2, 1, 1, 0, 2],
      [2, "COR3", 1, 1, 0, 1, 0, 0],
      [3, "PAL3", 0, 1, 0, 0, 1, -2],
    ]);
    expect(view.stages.map((st) => [st.round, st.matches.length])).toEqual([[1, 1], [2, 1], [3, 2]]);
    expect(view.stages[2]!.matches.map((m) => m.kickoff)).toEqual(["2027-06-10T17:00:00.000Z", "2027-06-13T19:00:00.000Z"]);
    // o jogo das 14h de Brasília, ainda agendado, está em jogo
    expect(view.stages[2]!.matches.map((m) => m.inPlay)).toEqual([true, false]);
  });

  it("nas copas não há classificação: as fases vêm em ordem, com o placar, quem passou (também nos pênaltis) e o clube de fora sem ticker", async () => {
    const view = competitionViewSchema.parse((await get("/competitions/copa-do-brasil")).json());
    expect(view.standings).toEqual([]);
    expect(view.stages.map((st) => st.phase)).toEqual(["1a-fase", "oitavas", "quartas"]);
    expect(view.stages[1]!.matches[0]).toMatchObject({ homeGoals: 1, awayGoals: 1, advanced: "away", home: { ticker: "FLA3" }, away: { ticker: "PAL3" } });
    expect(view.stages[0]!.matches[0]).toMatchObject({ advanced: "home", homeGoals: 3 });
    expect(view.stages[2]!.matches[0]!.away).toEqual({ ticker: null, name: "Clube de Fora" });
  });

  it("competição sem jogo devolve vazio, e competição desconhecida dá 400", async () => {
    const view = competitionViewSchema.parse((await get("/competitions/sulamericana")).json());
    expect(view).toEqual({ competition: "sulamericana", standings: [], stages: [] });
    expect((await get("/competitions/copa-do-mundo")).statusCode).toBe(400);
  });

  it("nada da casa: só o que o calendário mostra a todos", async () => {
    const text = JSON.stringify((await get("/competitions/brasileirao-a")).json());
    expect(text).not.toMatch(/fair|justo|wallet|user|projec/i);
  });
});
