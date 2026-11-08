import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { matches } from "../../src/infra/db/schema/index.js";
import { findPending, type PendingInput } from "../../src/modules/admin/results/pending.js";
import { createAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

const kickoff = new Date("2027-07-10T20:00:00Z");
const END = new Date(kickoff.getTime() + 2 * 3_600_000);
const HOUR = 3_600_000;

function game(id: number, extra: Partial<PendingInput> = {}): PendingInput {
  return {
    id,
    competition: "sulamericana",
    round: null,
    phase: "oitavas",
    homeTicker: "FLA3",
    homeName: "Flamengo",
    awayTicker: null,
    awayName: "Lanús",
    kickoff,
    finishedAt: null,
    status: "scheduled",
    outOfWindow: false,
    homeGoals: null,
    fetchedAt: null,
    ...extra,
  };
}

describe("pendências (função pura)", () => {
  it("admin 5: jogo da Sul-Americana sem placar 6 horas depois do fim previsto aparece com a fase que ele impede de fechar", () => {
    const now = new Date(END.getTime() + 6 * HOUR);
    const result = findPending([game(1)], now);
    expect(result.matches).toEqual([
      expect.objectContaining({ matchId: 1, competition: "sulamericana", phase: "oitavas", expectedEnd: END.toISOString() }),
    ]);
    expect(result.blocked).toEqual([{ competition: "sulamericana", round: null, phase: "oitavas", matchIds: [1] }]);
  });

  it("5 horas e 59 minutos depois do fim previsto não aparece (limite)", () => {
    const now = new Date(END.getTime() + 6 * HOUR - 60_000);
    expect(findPending([game(1)], now).matches).toEqual([]);
  });

  it("o fim previsto é o horário que o admin preencheu, quando há", () => {
    const finishedAt = new Date(END.getTime() + HOUR);
    const now = new Date(finishedAt.getTime() + 6 * HOUR - 1);
    expect(findPending([game(1, { finishedAt })], now).matches).toEqual([]);
    expect(findPending([game(1, { finishedAt })], new Date(now.getTime() + 1)).matches).toHaveLength(1);
  });

  it("jogo adiado, cancelado, fora da janela ou com placar não aparece", () => {
    const now = new Date(END.getTime() + 48 * HOUR);
    const result = findPending(
      [
        game(1, { status: "postponed" }),
        game(2, { status: "cancelled" }),
        game(3, { outOfWindow: true }),
        game(4, { status: "finished", homeGoals: 1 }),
      ],
      now,
    );
    expect(result.matches).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("rodada com dois jogos pendentes lista a rodada uma vez, com os dois jogos", () => {
    const now = new Date(END.getTime() + 10 * HOUR);
    const result = findPending(
      [
        game(1, { competition: "brasileirao-a", round: 12, phase: null }),
        game(2, { competition: "brasileirao-a", round: 12, phase: null }),
        game(3, { competition: "brasileirao-a", round: 13, phase: null }),
      ],
      now,
    );
    expect(result.matches).toHaveLength(3);
    expect(result.blocked).toEqual([
      { competition: "brasileirao-a", round: 12, phase: null, matchIds: [1, 2] },
      { competition: "brasileirao-a", round: 13, phase: null, matchIds: [3] },
    ]);
  });

  it("mostra a última importação por competição (o maior fetchedAt dos jogos)", () => {
    const result = findPending(
      [
        game(1, { status: "finished", homeGoals: 0, fetchedAt: "2027-07-10T10:00:00.000Z" }),
        game(2, { status: "finished", homeGoals: 0, fetchedAt: "2027-07-11T10:00:00.000Z" }),
        game(3, { competition: "brasileirao-a", round: 1, phase: null, status: "finished", homeGoals: 0, fetchedAt: null }),
      ],
      END,
    );
    expect(result.lastImports["sulamericana"]).toBe("2027-07-11T10:00:00.000Z");
    expect(result.lastImports["brasileirao-a"]).toBeNull();
  });
});

describe("GET /admin/pending", () => {
  const database = useTestDatabase(6);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
  });
  afterAll(() => app.close());

  it("admin 31: só o admin acessa", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/pending" }, { okStatus: 200 });
  });

  it("admin 5: devolve o jogo pendente da temporada atual no formato do contrato", async () => {
    const { seasonId, clubIds } = await seedSeason(database.db);
    await database.db.insert(matches).values({
      seasonId,
      competition: "brasileirao-a",
      round: 4,
      homeClubId: clubIds.get("FLA3")!,
      awayClubId: clubIds.get("PAL3")!,
      kickoff: new Date(clock.now().getTime() - 12 * HOUR),
      source: "espn",
      sourceId: "pend-1",
      sourceSnapshot: { status: "scheduled", homeGoals: null, awayGoals: null, kickoff: "x", fetchedAt: "2027-04-01T12:00:00.000Z" },
    });
    const admin = await createAccount(database.db, { role: "admin" });
    const res = await app.inject({ method: "GET", url: "/admin/pending", headers: bearer(admin.token) });
    expect(res.statusCode).toBe(200);
    const body = pendingResponseSchema.parse(res.json());
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0]).toMatchObject({ homeTicker: "FLA3", awayTicker: "PAL3", round: 4 });
    expect(body.blocked).toEqual([{ competition: "brasileirao-a", round: 4, phase: null, matchIds: [body.matches[0]!.matchId] }]);
    expect(body.lastImports["brasileirao-a"]).toBe("2027-04-01T12:00:00.000Z");
  });
});
