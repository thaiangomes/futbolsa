import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveGamesSchema } from "@futbolsa/contracts";
import type { LiveMatch } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { matches, seasonClubs } from "../../src/infra/db/schema/index.js";
import { LiveScores } from "../../src/modules/market/book/live-scores.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { marketSeason, type MarketSeason } from "./helpers.js";

// Item 25 da fila da partida de teste: GET /live-games alimenta a faixa e a página dos jogos ao vivo.

describe("jogos ao vivo (HTTP)", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date("2027-06-13T19:40:00Z")); // 16h40 de Brasília
  let parciais: LiveMatch[] = [];
  let app: NestFastifyApplication;
  let s: MarketSeason;
  const id = (t: string) => s.clubIds.get(t)!;
  const jogo = (home: string, away: string, kickoff: string, over: Partial<typeof matches.$inferInsert> = {}) => ({
    seasonId: s.seasonId,
    competition: "brasileirao-a",
    round: 9,
    homeClubId: id(home),
    awayClubId: id(away),
    kickoff: new Date(kickoff),
    ...over,
  });
  const read = async () => liveGamesSchema.parse((await app.inject({ method: "GET", url: "/live-games" })).json());

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: (b) => withTestAuth(clock)(b).overrideProvider(LiveScores).useValue({ at: () => parciais }) });
    s = await marketSeason(database.db);
    // preço de hoje contra o das 0h (o do IPO, R$ 40,00): FLA3 sobe 10%, PAL3 cai 5%
    await database.db.update(seasonClubs).set({ lastPrice: 4400 }).where(eq(seasonClubs.clubId, id("FLA3")));
    await database.db.update(seasonClubs).set({ lastPrice: 3800 }).where(eq(seasonClubs.clubId, id("PAL3")));
    await database.db.insert(matches).values([
      jogo("FLA3", "PAL3", "2027-06-13T19:00:00Z"), // em andamento (16h)
      jogo("SPT3", "COR3", "2027-06-13T14:00:00Z", { status: "finished", homeGoals: 2, awayGoals: 1 }), // encerrado hoje
      jogo("COR3", "FLA3", "2027-06-13T21:30:00Z"), // mais tarde hoje
      jogo("PAL3", "SPT3", "2027-06-16T22:00:00Z"), // outro dia
    ]);
  });
  afterAll(() => app.close());

  it("é pública e separa em andamento, mais tarde e encerrados, com preço e variação do dia de cada time", async () => {
    const view = await read();
    expect(view.live).toHaveLength(1);
    expect(view.live[0]).toMatchObject({ competition: "brasileirao-a", round: 9, minute: 40, score: null });
    expect(view.live[0]!.home).toMatchObject({ ticker: "FLA3", price: 4400, changeBp: 1000 });
    expect(view.live[0]!.away).toMatchObject({ ticker: "PAL3", price: 3800, changeBp: -500 });
    expect(view.upcoming.map((g) => g.home.ticker)).toEqual(["COR3"]);
    expect(view.finished.map((g) => g.score)).toEqual([{ home: 2, away: 1 }]);
    expect(view.next).toMatchObject({ kickoff: "2027-06-13T21:30:00.000Z" });
  });

  it("o placar e o minuto parciais da fonte entram no jogo em andamento", async () => {
    parciais = [{ home: "FLA3", away: "PAL3", homeGoals: 1, awayGoals: 1, minute: 38 }];
    const [g] = (await read()).live;
    expect(g).toMatchObject({ minute: 38, score: { home: 1, away: 1 } });
    parciais = [];
  });

  it("sem jogo em andamento, a lista de ao vivo fica vazia e o próximo jogo aparece", async () => {
    await database.db.update(matches).set({ status: "finished", homeGoals: 0, awayGoals: 0 }).where(eq(matches.kickoff, new Date("2027-06-13T19:00:00Z")));
    const view = await read();
    expect(view.live).toEqual([]);
    expect(view.finished).toHaveLength(2);
    expect(view.next).not.toBeNull();
  });

  it("nada da casa na resposta", async () => {
    expect(JSON.stringify(await read())).not.toMatch(/fair|justo|wallet|user|projec/i);
  });
});
