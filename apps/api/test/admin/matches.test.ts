import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AdminMatch, listMatchesResponseSchema, pendingResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, matches, seasons } from "../../src/infra/db/schema/index.js";
import { type MatchesChangedEvent, MatchesEvents } from "../../src/modules/admin/results/ports.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

const HOUR = 3_600_000;

describe("jogos do admin", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let events: MatchesChangedEvent[];

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin" });
    ({ seasonId, clubIds } = await seedSeason(database.db));
    events = [];
    app.get(MatchesEvents, { strict: false }).subscribe((e) => {
      events.push(e);
    });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    events.length = 0;
    await database.db.delete(matches);
    await database.db.update(seasons).set({ status: "preparing" }).where(eq(seasons.id, seasonId));
  });

  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(admin.token), ...(payload ? { payload } : {}) });

  async function insertMatch(extra: Partial<typeof matches.$inferInsert> = {}) {
    const [row] = await database.db
      .insert(matches)
      .values({
        seasonId,
        competition: "brasileirao-a",
        round: 7,
        homeClubId: clubIds.get("FLA3")!,
        awayClubId: clubIds.get("PAL3")!,
        kickoff: new Date(clock.now().getTime() - 12 * HOUR),
        source: "espn",
        sourceId: `m-${Math.random()}`,
        ...extra,
      })
      .returning();
    return row!;
  }

  const logOf = (action: string) => database.db.select().from(adminLog).where(eq(adminLog.action, action));

  it("admin 31: jogador comum não acessa as rotas de jogos", async () => {
    const m = await insertMatch();
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/matches" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "PATCH", url: `/admin/matches/${m.id}`, payload: { status: "cancelled", reason: "teste" } });
    await expectAdminOnly(app, database.db, {
      method: "POST",
      url: "/admin/matches",
      payload: {
        competition: "brasileirao-a",
        round: 1,
        homeClubId: clubIds.get("FLA3"),
        awayClubId: clubIds.get("SAN3"),
        kickoff: "2027-05-01T21:00:00Z",
        reason: "teste",
      },
    });
  });

  it("admin 33: editar placar sem motivo é recusado (também preencher, cadastrar, marcar adiado e cancelar)", async () => {
    const m = await insertMatch();
    const bodies: object[] = [
      { homeGoals: 2, awayGoals: 1 },
      { status: "postponed" },
      { status: "cancelled" },
      { kickoff: "2027-05-01T21:00:00Z" },
      { homeGoals: 2, awayGoals: 1, reason: "  " },
    ];
    for (const body of bodies) {
      const res = await call("PATCH", `/admin/matches/${m.id}`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().code).toBe("invalid_input");
    }
    const create = await call("POST", "/admin/matches", {
      competition: "brasileirao-a",
      round: 1,
      homeClubId: clubIds.get("FLA3"),
      awayClubId: clubIds.get("SAN3"),
      kickoff: "2027-05-01T21:00:00Z",
    });
    expect(create.statusCode).toBe(400);
    expect(await database.db.select().from(matches)).toHaveLength(1);
    expect((await logOf("match.update")).filter((l) => l.targetId === String(m.id))).toHaveLength(0);
  });

  it("preencher o placar que faltou grava o jogo como do admin, registra antes e depois com o motivo e avisa a F12", async () => {
    const m = await insertMatch();
    const res = await call("PATCH", `/admin/matches/${m.id}`, { homeGoals: 2, awayGoals: 1, reason: "a fonte não trouxe" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: m.id, status: "finished", homeGoals: 2, awayGoals: 1, manualOverride: true });
    const [log] = (await logOf("match.update")).filter((l) => l.targetId === String(m.id));
    expect(log).toMatchObject({
      actorId: admin.id,
      targetType: "match",
      targetId: String(m.id),
      reason: "a fonte não trouxe",
      before: expect.objectContaining({ status: "scheduled", homeGoals: null, awayGoals: null }),
      after: expect.objectContaining({ status: "finished", homeGoals: 2, awayGoals: 1 }),
    });
    expect(events).toEqual([expect.objectContaining({ seasonId, competition: "brasileirao-a", matchIds: [m.id], scoreChanged: true })]);
  });

  it("admin 6: o placar do admin continua e a tela vê o que a fonte diz (divergência)", async () => {
    const m = await insertMatch({
      status: "finished",
      homeGoals: 2,
      awayGoals: 0,
      manualOverride: true,
      sourceSnapshot: { status: "finished", homeGoals: 1, awayGoals: 1, kickoff: "2027-04-01T00:00:00.000Z", fetchedAt: "2027-04-01T12:00:00.000Z" },
    });
    await insertMatch({ homeClubId: clubIds.get("VAS3")!, awayClubId: clubIds.get("SAN3")!, sourceId: "ok", status: "finished", homeGoals: 1, awayGoals: 0 });
    const res = await call("GET", "/admin/matches");
    expect(res.statusCode).toBe(200);
    const body = listMatchesResponseSchema.parse(res.json());
    const edited = body.matches.find((x: AdminMatch) => x.id === m.id)!;
    expect(edited).toMatchObject({ diverges: true, manualOverride: true, sourceView: { homeGoals: 1, awayGoals: 1 } });
    expect(body.matches.find((x: AdminMatch) => x.id !== m.id)!.diverges).toBe(false);
    const onlyDiverging = listMatchesResponseSchema.parse((await call("GET", "/admin/matches?diverging=true")).json());
    expect(onlyDiverging.matches.map((x: AdminMatch) => x.id)).toEqual([m.id]);
  });

  it("admin 8: marcar o jogo como adiado o tira das pendências; desmarcar devolve o jogo à rodada", async () => {
    const m = await insertMatch();
    const pending = async () => pendingResponseSchema.parse((await call("GET", "/admin/pending")).json()).matches.map((x) => x.matchId);
    expect(await pending()).toEqual([m.id]);

    const marked = await call("PATCH", `/admin/matches/${m.id}`, { status: "postponed", reason: "chuva forte" });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ status: "postponed", manualOverride: true });
    expect(await pending()).toEqual([]);

    // a importação marcou fora da janela: o admin desmarca, e as duas colunas zeram
    await database.db.update(matches).set({ outOfWindow: true }).where(eq(matches.id, m.id));
    const unmarked = await call("PATCH", `/admin/matches/${m.id}`, { status: "scheduled", reason: "jogo foi mantido" });
    expect(unmarked.json()).toMatchObject({ status: "scheduled", outOfWindow: false, manualOverride: true });
    expect(await pending()).toEqual([m.id]);
  });

  it("jogo cancelado perde o placar e sai das pendências", async () => {
    const m = await insertMatch({ status: "finished", homeGoals: 1, awayGoals: 1 });
    const res = await call("PATCH", `/admin/matches/${m.id}`, { status: "cancelled", reason: "partida anulada" });
    expect(res.json()).toMatchObject({ status: "cancelled", homeGoals: null, awayGoals: null });
  });

  it("admin 18: temporada encerrada não aceita correção nem cadastro", async () => {
    const m = await insertMatch({ status: "finished", homeGoals: 1, awayGoals: 0 });
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, seasonId));
    const patch = await call("PATCH", `/admin/matches/${m.id}`, { homeGoals: 3, awayGoals: 0, reason: "correção" });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().code).toBe("season_closed");
    const [row] = await database.db.select().from(matches).where(eq(matches.id, m.id));
    expect(row).toMatchObject({ homeGoals: 1, awayGoals: 0 });
    const create = await call("POST", "/admin/matches", {
      competition: "brasileirao-a",
      round: 1,
      homeClubId: clubIds.get("FLA3"),
      awayClubId: clubIds.get("SAN3"),
      kickoff: "2027-05-01T21:00:00Z",
      reason: "teste",
    });
    expect(create.statusCode).toBe(409);
  });

  it("quem passou só aceita um dos dois clubes do jogo, e só em copa", async () => {
    const cup = await insertMatch({ competition: "copa-do-brasil", round: null, phase: "oitavas", sourceId: "cup-1" });
    const wrong = await call("PATCH", `/admin/matches/${cup.id}`, {
      homeGoals: 1,
      awayGoals: 1,
      advancedClubId: clubIds.get("VAS3"),
      reason: "pênaltis",
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: "invalid_input", fields: ["advancedClubId"] });
    const ok = await call("PATCH", `/admin/matches/${cup.id}`, {
      homeGoals: 1,
      awayGoals: 1,
      advancedClubId: clubIds.get("PAL3"),
      reason: "pênaltis",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ advancedClubId: clubIds.get("PAL3") });
    const league = await insertMatch({ sourceId: "lg-1" });
    const inLeague = await call("PATCH", `/admin/matches/${league.id}`, {
      homeGoals: 1,
      awayGoals: 1,
      advancedClubId: clubIds.get("PAL3"),
      reason: "pênaltis",
    });
    expect(inLeague.statusCode).toBe(400);
  });

  it("placar negativo ou não inteiro é recusado, e placar pela metade também", async () => {
    const m = await insertMatch();
    for (const body of [{ homeGoals: -1, awayGoals: 0 }, { homeGoals: 1.5, awayGoals: 0 }, { homeGoals: 1 }, { homeGoals: 1, awayGoals: 0, status: "scheduled" }]) {
      const res = await call("PATCH", `/admin/matches/${m.id}`, { ...body, reason: "correção" });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    const [row] = await database.db.select().from(matches).where(eq(matches.id, m.id));
    expect(row).toMatchObject({ status: "scheduled", homeGoals: null });
  });

  it("corrigir a rodada ou a fase de um jogo que a fonte numerou errado", async () => {
    const m = await insertMatch({ round: 9 });
    const res = await call("PATCH", `/admin/matches/${m.id}`, { round: 5, reason: "rodada derivada errada" });
    expect(res.json()).toMatchObject({ round: 5, manualOverride: true });
  });

  it("cadastrar um jogo que a fonte não trouxe: fica como do admin, sem fonte, e registra o motivo", async () => {
    const res = await call("POST", "/admin/matches", {
      competition: "sulamericana",
      phase: "oitavas",
      homeClubId: clubIds.get("BAH3"),
      awayClubId: clubIds.get("CRU3"),
      kickoff: "2027-08-20T22:00:00-03:00",
      reason: "a ESPN não trouxe",
    });
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ source: "manual", manualOverride: true, status: "scheduled", phase: "oitavas", round: null, kickoff: "2027-08-21T01:00:00.000Z" });
    const [log] = (await logOf("match.create")).filter((l) => l.targetId === String(created.id));
    expect(log).toMatchObject({ targetType: "match", targetId: String(created.id), reason: "a ESPN não trouxe", before: null });
    expect(log!.after).toMatchObject({ competition: "sulamericana", phase: "oitavas" });
    expect(events).toEqual([expect.objectContaining({ competition: "sulamericana", scoreChanged: false })]);
  });

  it("cadastrar com clube que não existe ou com a competição sem rodada é recusado", async () => {
    const base = { competition: "brasileirao-a", round: 3, homeClubId: clubIds.get("FLA3"), awayClubId: 999_999, kickoff: "2027-05-01T21:00:00Z", reason: "teste" };
    expect((await call("POST", "/admin/matches", base)).statusCode).toBe(400);
    const noRound = { ...base, awayClubId: clubIds.get("SAN3"), round: undefined, phase: "oitavas" };
    expect((await call("POST", "/admin/matches", noRound)).statusCode).toBe(400);
    expect(await database.db.select().from(matches).where(and(eq(matches.seasonId, seasonId)))).toHaveLength(0);
  });

  it("jogo que não existe volta 404", async () => {
    const res = await call("PATCH", "/admin/matches/987654", { status: "cancelled", reason: "teste" });
    expect(res.statusCode).toBe(404);
  });
});
