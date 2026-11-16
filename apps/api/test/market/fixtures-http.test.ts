import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clubFixturesSchema, clubListSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { clubs, matches } from "../../src/infra/db/schema/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { marketSeason, type MarketSeason } from "./helpers.js";

// Item 9 da fila da partida de teste: os próximos jogos de cada clube. GET /clubs/:ticker/fixtures e o nextMatch de GET /clubs.

describe("próximos jogos (HTTP)", () => {
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
    round: competition.startsWith("brasileirao") ? 12 : null,
    phase: competition.startsWith("brasileirao") ? null : "oitavas",
    homeClubId: id(home),
    awayClubId: id(away),
    kickoff: new Date(kickoff),
    ...over,
  });

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    // um clube de fora da lista da temporada (sem ticker) como adversário
    const [fora] = await database.db.insert(clubs).values({ name: "Clube de Fora" }).returning({ id: clubs.id });
    await database.db.insert(matches).values([
      // FLA3: em jogo agora (começou às 14h de Brasília e o placar ainda não chegou), depois o Brasileirão em casa, depois a Libertadores fora
      jogo("copa-do-brasil", "FLA3", "PAL3", "2027-06-10T17:00:00Z"),
      jogo("brasileirao-a", "FLA3", "SPT3", "2027-06-13T19:00:00Z"),
      jogo("libertadores", "COR3", "FLA3", "2027-06-20T22:00:00Z"),
      { ...jogo("sulamericana", "FLA3", "PAL3", "2027-06-25T22:00:00Z"), awayClubId: fora!.id },
      // não entram: já acabou, cancelado e adiado
      jogo("brasileirao-a", "FLA3", "PAL3", "2027-06-05T19:00:00Z", { status: "finished", homeGoals: 1, awayGoals: 0 }),
      jogo("brasileirao-a", "FLA3", "COR3", "2027-06-12T19:00:00Z", { status: "cancelled" }),
      jogo("brasileirao-a", "FLA3", "SPT3", "2027-06-14T19:00:00Z", { status: "postponed" }),
      // PAL3: só o jogo contra o FLA3 e o da Libertadores contra o COR3
      jogo("libertadores", "PAL3", "COR3", "2027-06-18T22:00:00Z"),
    ]);
  });
  afterAll(() => app.close());

  it("livro 50: é pública: devolve só os jogos agendados do clube, do mais perto para o mais longe, com mando, adversário, competição e fase", async () => {
    const res = await get("/clubs/FLA3/fixtures");
    expect(res.statusCode).toBe(200);
    const view = clubFixturesSchema.parse(res.json());
    expect(view.ticker).toBe("FLA3");
    expect(view.fixtures.map((f) => [f.kickoff, f.competition, f.home, f.opponent.ticker])).toEqual([
      ["2027-06-10T17:00:00.000Z", "copa-do-brasil", true, "PAL3"],
      ["2027-06-13T19:00:00.000Z", "brasileirao-a", true, "SPT3"],
      ["2027-06-20T22:00:00.000Z", "libertadores", false, "COR3"],
      ["2027-06-25T22:00:00.000Z", "sulamericana", true, null],
    ]);
    expect(view.fixtures[0]).toMatchObject({ phase: "oitavas", round: null });
    expect(view.fixtures[1]).toMatchObject({ phase: null, round: 12 });
    expect(view.fixtures[3]!.opponent).toEqual({ ticker: null, name: "Clube de Fora" });
  });

  it("o jogo que já passou do horário e ainda está agendado é \"em jogo agora\"; os outros não", async () => {
    const view = clubFixturesSchema.parse((await get("/clubs/FLA3/fixtures")).json());
    expect(view.fixtures.map((f) => f.inPlay)).toEqual([true, false, false, false]);
  });

  it("o adversário vê o mesmo jogo do lado dele (visitante na Copa do Brasil)", async () => {
    const view = clubFixturesSchema.parse((await get("/clubs/PAL3/fixtures")).json());
    expect(view.fixtures[0]).toMatchObject({ competition: "copa-do-brasil", home: false, opponent: { ticker: "FLA3" }, inPlay: true });
    expect(view.fixtures.map((f) => f.competition)).toEqual(["copa-do-brasil", "libertadores"]);
  });

  it("clube sem jogo agendado devolve a lista vazia", async () => {
    const view = clubFixturesSchema.parse((await get("/clubs/SPT3/fixtures")).json());
    expect(view.fixtures.map((f) => f.competition)).toEqual(["brasileirao-a"]); // só o que o FLA3 joga em casa contra ele
    await database.db.delete(matches).where(eq(matches.awayClubId, id("SPT3")));
    expect(clubFixturesSchema.parse((await get("/clubs/SPT3/fixtures")).json()).fixtures).toEqual([]);
  });

  it("a lista de clubes traz o próximo jogo de cada um (ou nulo)", async () => {
    const list = clubListSchema.parse((await get("/clubs")).json());
    const next = new Map(list.clubs.map((c) => [c.ticker, c.nextMatch]));
    expect(next.get("FLA3")).toMatchObject({ kickoff: "2027-06-10T17:00:00.000Z", competition: "copa-do-brasil", home: true, opponent: { ticker: "PAL3" }, inPlay: true });
    expect(next.get("COR3")).toMatchObject({ competition: "libertadores", kickoff: "2027-06-18T22:00:00.000Z", home: false, opponent: { ticker: "PAL3" } });
    expect(next.get("SPT3")).toBeNull();
  });

  it("nada da casa: o jogo só traz o que o calendário mostra a todos", async () => {
    const text = JSON.stringify((await get("/clubs/FLA3/fixtures")).json());
    expect(text).not.toMatch(/fair|justo|wallet|user|projec/i);
  });

  it("ticker fora da lista da temporada dá 404, e de formato inválido, 400", async () => {
    expect((await get("/clubs/ZZZ9/fixtures")).statusCode).toBe(404);
    expect((await get("/clubs/fla3/fixtures")).statusCode).toBe(400);
  });
});
