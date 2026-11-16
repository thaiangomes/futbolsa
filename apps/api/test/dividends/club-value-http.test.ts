import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clubValueViewSchema } from "@futbolsa/contracts";
import { clubValue, type ClubValueInput } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { matches, payoutEvents, seasonClubs, standings } from "../../src/infra/db/schema/index.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, seedSeason } from "../support/fixtures.js";
import { eq } from "drizzle-orm";

// T12 do Plano dos dividendos e pagamentos: GET /clubs/:ticker/dividends, o que o cartão "Quanto vale para você" precisa.

describe("GET /clubs/:ticker/dividends (T12)", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(new Date("2027-06-10T18:00:00Z"));
  let app: NestFastifyApplication;
  let seasonId: number;
  let clubIds: Map<string, number>;

  const get = (url: string) => app.inject({ method: "GET", url });
  const id = (ticker: string) => clubIds.get(ticker)!;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    ({ seasonId, clubIds } = await seedSeason(database.db));
    await listClubs(database.db, seasonId, clubIds, ["FLA3", "PAL3", "SPT3"], 3000);
    await database.db.update(seasonClubs).set({ ipoPrice: 4000, lastPrice: 4430 }).where(eq(seasonClubs.seasonId, seasonId));
    const values = app.get(SeasonValuesService, { strict: false });
    await withTransaction(database.db, (tx) => values.createInitial(tx, seasonId).then(() => undefined));

    // FLA3: R$ 2,70 pagos (aprovados), R$ 0,30 a receber (fechado, sem aprovação) e uma versão antiga que não conta
    const at = new Date("2027-06-01T20:00:00Z");
    const evento = { seasonId, clubId: id("FLA3"), kind: "points", reason: "pontos", competition: "brasileirao-a", closedAt: at, createdAt: at };
    await database.db.insert(payoutEvents).values([
      { ...evento, eventKey: "points|brasileirao-a|1|FLA3", perShare: 270, status: "approved" },
      { ...evento, eventKey: "points|brasileirao-a|2|FLA3", perShare: 30, status: "pending" },
      { ...evento, eventKey: "points|brasileirao-a|3|FLA3", perShare: 999, status: "superseded", version: 1 },
      // ainda não fechado no relógio do teste: não aparece
      { ...evento, eventKey: "points|brasileirao-a|4|FLA3", perShare: 50, status: "pending", closedAt: new Date("2027-06-30T20:00:00Z") },
    ]);
    await database.db.insert(standings).values({ seasonId, competition: "brasileirao-a", clubId: id("FLA3"), position: 5, points: 20 });

    const jogo = (competition: string, phase: string | null, home: string, away: string) => ({
      seasonId,
      competition,
      phase,
      round: phase === null ? 10 : null,
      homeClubId: id(home),
      awayClubId: id(away),
      kickoff: new Date("2027-06-20T22:00:00Z"),
    });
    await database.db.insert(matches).values([
      jogo("brasileirao-a", null, "FLA3", "PAL3"),
      jogo("copa-do-brasil", "oitavas", "FLA3", "PAL3"),
      jogo("libertadores", "grupos", "FLA3", "PAL3"),
    ]);
  });
  afterAll(() => app.close());

  it("livro 51: é pública e devolve o pago, o a receber, os pontos, a colocação, os jogos, a fase e o resultado de cada copa e os valores da temporada", async () => {
    const res = await get("/clubs/FLA3/dividends");
    expect(res.statusCode).toBe(200);
    const view = clubValueViewSchema.parse(res.json());
    expect(view).toMatchObject({
      ticker: "FLA3",
      league: "brasileirao-a",
      leagueOpen: true,
      points: 20,
      position: 5,
      played: 0,
      paid: 270,
      toReceive: 30,
      buybackMultipleBp: 15_000,
      leagueRules: { perPoint: 10 },
    });
    expect(view.leagueRules.placement.slice(0, 3)).toEqual([500, 450, 400]);
    expect(view.cups.map((c) => [c.competition, c.currentPhase, c.outcome])).toEqual([
      ["copa-do-brasil", "oitavas", "playing"],
      ["libertadores", "grupos", "playing"],
    ]);
    expect(view.cups[0]!.advance).toMatchObject({ oitavas: 150, quartas: 250 });
    expect(view.cups[0]!.title).toBe(800);
  });

  it("livro 38: o navegador e o motor dão o mesmo número com o que a rota devolve (faltam R$ 14,35; valor R$ 39,93; preço com downside de 10%)", async () => {
    const view = clubValueViewSchema.parse((await get("/clubs/FLA3/dividends")).json());
    const values = {
      leagues: { [view.league]: view.leagueRules },
      cups: Object.fromEntries(view.cups.map((c) => [c.competition, { phases: c.phases, advance: c.advance, ...(c.advanceTo ? { advanceTo: c.advanceTo } : {}), title: c.title }])),
    };
    const input: ClubValueInput = {
      values,
      league: view.league,
      leagueOpen: view.leagueOpen,
      paid: view.paid,
      toReceive: view.toReceive,
      points: view.points,
      buybackMultipleBp: view.buybackMultipleBp,
      displayedPrice: 4430,
      cups: view.cups.map((c) => ({ competition: c.competition, currentPhase: c.currentPhase })),
    };
    expect(clubValue(input).buybackNow).toBe(450);
    const s = clubValue(input, { points: 68, position: 3, cups: { "copa-do-brasil": "quartas", libertadores: "quartas" } }).simulation!;
    expect(s.missing.total).toBe(1435);
    expect(s.buyback).toBe(2558);
    expect(s.value).toBe(3993);
    expect(s.outlook).toEqual({ kind: "downside", percent: 10 });
  });

  it("clube sem jogo de copa devolve só o campeonato, e sem pagamentos zera o pago e o a receber", async () => {
    const view = clubValueViewSchema.parse((await get("/clubs/SPT3/dividends")).json());
    expect(view).toMatchObject({ paid: 0, toReceive: 0, points: 0, position: null, cups: [] });
  });

  it("não mostra o valor justo da casa nem nada de dono", async () => {
    const text = JSON.stringify((await get("/clubs/FLA3/dividends")).json());
    expect(text).not.toMatch(/fair|justo|projec|wallet|user/i);
  });

  it("clube fora da lista da temporada: 404; ticker de formato inválido: 400", async () => {
    expect((await get("/clubs/ZZZ9/dividends")).statusCode).toBe(404);
    expect((await get("/clubs/fla3/dividends")).statusCode).toBe(400);
  });

  it("campeonato com todos os jogos acabados fica fechado (a aposta em pontos e colocação não vale)", async () => {
    await database.db.update(matches).set({ status: "finished", homeGoals: 1, awayGoals: 0, finishedAt: new Date("2027-06-21T00:00:00Z") }).where(eq(matches.competition, "brasileirao-a"));
    const view = clubValueViewSchema.parse((await get("/clubs/FLA3/dividends")).json());
    expect(view.leagueOpen).toBe(false);
    expect(view.played).toBe(1); // o jogo do Brasileirão que acabou (FLA3 x PAL3)
  });
});
