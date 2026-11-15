import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { standingsResponseSchema, standingsViewSchema } from "@futbolsa/contracts";
import { CLUBS } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, clubs, seasons, standings } from "../../src/infra/db/schema/index.js";
import { StandingsService } from "../../src/modules/admin/standings/standings.service.js";
import { convertEspnStandings } from "../../src/modules/admin/results/sources/espn.js";
import type { SourceStanding } from "../../src/modules/admin/results/sources/types.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

/** A tabela da Série A: os 20 clubes listados, do primeiro ao último. */
const tableA = (): SourceStanding[] => CLUBS.map((c, i) => ({ clubName: c.name, position: i + 1, points: 80 - i * 3 }));

describe("classificação oficial", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let service: StandingsService;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin", nickname: "chefe" });
    ({ seasonId } = await seedSeason(database.db));
    service = app.get(StandingsService, { strict: false });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await database.db.delete(standings);
    await database.db.update(seasons).set({ status: "preparing" }).where(eq(seasons.id, seasonId));
  });

  const call = (method: "GET" | "PATCH" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(admin.token), ...(payload ? { payload } : {}) });
  const view = async (competition: "brasileirao-a" | "brasileirao-b") =>
    standingsResponseSchema.parse((await call("GET", "/admin/standings")).json()).standings.find((s) => s.competition === competition)!;

  it("admin 31: jogador comum não acessa as rotas da classificação", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/standings" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "PATCH", url: "/admin/standings/brasileirao-a", payload: { order: [1, 2], reason: "teste" } });
    await expectAdminOnly(app, database.db, { method: "POST", url: "/admin/standings/brasileirao-a/confirm" });
  });

  it("a Série B entra inteira, com clube não listado criado sem ticker", async () => {
    const report = await service.importStandings(seasonId, "brasileirao-b", convertEspnStandings(fixture("espn-standings-bra2-2025.json")));
    expect(report.inserted).toBe(20);
    expect(report.clubsCreated.length).toBeGreaterThan(10);
    const b = await view("brasileirao-b");
    expect(b.rows).toHaveLength(20);
    expect(b.rows[0]).toMatchObject({ position: 1, club: { name: "Coritiba", ticker: "CFC3" }, sourcePosition: 1 });
    expect(b.manualOverride).toBe(false);
    expect(b.confirmedAt).toBeNull();
    // o Coritiba, promovido para 2026, já tem ticker (CFC3); um clube que a fonte traz e o jogo não lista entra sem ticker
    const created = await database.db.select().from(clubs).where(eq(clubs.name, "Criciúma"));
    expect(created).toEqual([expect.objectContaining({ ticker: null })]);
  });

  it("a Série A usa os clubes listados da temporada", async () => {
    await service.importStandings(seasonId, "brasileirao-a", tableA());
    const a = await view("brasileirao-a");
    expect(a.rows).toHaveLength(CLUBS.length);
    expect(a.rows[0]!.club.ticker).toBe("FLA3");
    expect(a.rows[CLUBS.length - 1]!.club.ticker).toBe(CLUBS.at(-1)!.id);
  });

  it("conferir grava autor e hora, e nada muda na ordem", async () => {
    await service.importStandings(seasonId, "brasileirao-a", tableA());
    const res = await call("POST", "/admin/standings/brasileirao-a/confirm");
    expect(res.statusCode).toBe(200);
    expect(standingsViewSchema.parse(res.json())).toMatchObject({ confirmedBy: "chefe", confirmedAt: clock.now().toISOString() });
    const rows = await database.db.select().from(standings).where(eq(standings.competition, "brasileirao-a"));
    expect(rows.every((r) => r.confirmedBy === admin.id)).toBe(true);
    const log = (await database.db.select().from(adminLog).where(eq(adminLog.action, "standings.confirm"))).at(-1);
    expect(log).toMatchObject({ actorId: admin.id, targetType: "standings", targetId: "brasileirao-a" });
  });

  it("a correção exige motivo e a ordem completa dos clubes", async () => {
    await service.importStandings(seasonId, "brasileirao-a", tableA());
    const ids = (await view("brasileirao-a")).rows.map((r) => r.club.id);
    const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];
    expect((await call("PATCH", "/admin/standings/brasileirao-a", { order: swapped })).statusCode).toBe(400);
    expect((await call("PATCH", "/admin/standings/brasileirao-a", { order: swapped, reason: " " })).statusCode).toBe(400);
    const short = await call("PATCH", "/admin/standings/brasileirao-a", { order: swapped.slice(1), reason: "faltou um" });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ code: "invalid_input", fields: ["order"] });
    const stranger = await call("PATCH", "/admin/standings/brasileirao-a", { order: [...ids.slice(1), 999_999], reason: "clube de fora" });
    expect(stranger.statusCode).toBe(400);
    expect((await view("brasileirao-a")).rows.map((r) => r.club.id)).toEqual(ids);
  });

  it("corrigir a ordem grava o antes e o depois, marca como do admin e tira a conferência", async () => {
    await service.importStandings(seasonId, "brasileirao-a", tableA());
    await call("POST", "/admin/standings/brasileirao-a/confirm");
    const ids = (await view("brasileirao-a")).rows.map((r) => r.club.id);
    const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];
    const res = await call("PATCH", "/admin/standings/brasileirao-a", { order: swapped, reason: "a fonte trocou os dois primeiros" });
    expect(res.statusCode).toBe(200);
    const body = standingsViewSchema.parse(res.json());
    expect(body.rows.map((r) => r.club.id)).toEqual(swapped);
    expect(body).toMatchObject({ manualOverride: true, confirmedBy: null, confirmedAt: null });
    expect(body.rows[0]).toMatchObject({ position: 1, sourcePosition: 2 });
    const log = (await database.db.select().from(adminLog).where(eq(adminLog.action, "standings.update"))).at(-1);
    expect(log).toMatchObject({ reason: "a fonte trocou os dois primeiros", before: { order: ids }, after: { order: swapped } });
  });

  it("a importação não pisa na correção manual: a ordem fica e a tela mostra a diferença para a fonte", async () => {
    await service.importStandings(seasonId, "brasileirao-a", tableA());
    const ids = (await view("brasileirao-a")).rows.map((r) => r.club.id);
    const swapped = [ids[1]!, ids[0]!, ...ids.slice(2)];
    await call("PATCH", "/admin/standings/brasileirao-a", { order: swapped, reason: "correção do admin" });
    await call("POST", "/admin/standings/brasileirao-a/confirm");

    // a fonte agora traz o terceiro na frente
    const moved = tableA();
    moved.unshift({ ...moved.splice(2, 1)[0]!, position: 1 });
    moved.forEach((r, i) => (r.position = i + 1));
    const report = await service.importStandings(seasonId, "brasileirao-a", moved);
    expect(report).toMatchObject({ inserted: 0 });
    const after = await view("brasileirao-a");
    expect(after.rows.map((r) => r.club.id)).toEqual(swapped);
    expect(after.manualOverride).toBe(true);
    expect(after.confirmedBy).toBe("chefe");
    const third = after.rows.find((r) => r.club.id === ids[2])!;
    expect(third).toMatchObject({ position: 3, sourcePosition: 1 });
  });

  it("dividendos 8: correção do admin que termina no meio da importação não é apagada pela importação", async () => {
    await service.importStandings(seasonId, "brasileirao-a", tableA());
    const ids = (await view("brasileirao-a")).rows.map((r) => r.club.id);

    // a correção do admin numa transação que ainda não terminou (segura as linhas da tabela)
    const adminTx = await database.conn.pool.connect();
    try {
      await adminTx.query("begin");
      await adminTx.query(
        "update futbolsa.standings set manual_override = true where season_id = $1 and competition = 'brasileirao-a'",
        [seasonId],
      );
      const moved = tableA();
      [moved[0]!.position, moved[1]!.position] = [2, 1];
      const running = service.importStandings(seasonId, "brasileirao-a", moved);
      // espera a importação parar nas linhas travadas pelo admin, e só então o admin termina
      for (let i = 0; i < 100; i++) {
        const res = await database.conn.pool.query(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (res.rows[0].n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await adminTx.query("commit");
      await running;
    } finally {
      adminTx.release();
    }
    const after = await view("brasileirao-a");
    expect(after.manualOverride).toBe(true);
    expect(after.rows.map((r) => r.club.id)).toEqual(ids);
  });

  it("a importação que muda a tabela sem correção manual tira a conferência; a que não muda, não", async () => {
    await service.importStandings(seasonId, "brasileirao-a", tableA());
    await call("POST", "/admin/standings/brasileirao-a/confirm");
    expect((await view("brasileirao-a")).confirmedAt).not.toBeNull();

    const same = await service.importStandings(seasonId, "brasileirao-a", tableA());
    expect(same).toMatchObject({ inserted: 0, updated: 0, unchanged: CLUBS.length });
    expect((await view("brasileirao-a")).confirmedAt).not.toBeNull();

    const changed = tableA();
    [changed[0]!.position, changed[1]!.position] = [2, 1];
    const diff = await service.importStandings(seasonId, "brasileirao-a", changed);
    expect(diff.updated).toBeGreaterThan(0);
    const after = await view("brasileirao-a");
    expect(after.confirmedAt).toBeNull();
    expect(after.rows[0]!.club.ticker).toBe("FLU3");
  });

  it("sem tabela importada, corrigir e conferir voltam 404", async () => {
    expect((await call("POST", "/admin/standings/brasileirao-b/confirm")).statusCode).toBe(404);
    expect((await call("PATCH", "/admin/standings/brasileirao-b", { order: [1, 2], reason: "teste" })).statusCode).toBe(404);
  });

  it("competição que não é de pontos corridos é recusada", async () => {
    expect((await call("POST", "/admin/standings/copa-do-brasil/confirm")).statusCode).toBe(400);
  });

  it("admin 18: temporada encerrada não aceita importação nem correção", async () => {
    await service.importStandings(seasonId, "brasileirao-a", tableA());
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, seasonId));
    await expect(service.importStandings(seasonId, "brasileirao-a", tableA())).rejects.toMatchObject({ code: "season_closed" });
    const ids = (await database.db.select().from(standings).where(and(eq(standings.seasonId, seasonId)))).map((r) => r.clubId);
    expect((await call("PATCH", "/admin/standings/brasileirao-a", { order: ids, reason: "tarde demais" })).statusCode).toBe(409);
  });

});
