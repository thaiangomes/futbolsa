import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { historyResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { rankingRows, rankingSnapshots, seasons, users, wallets } from "../../src/infra/db/schema/index.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { CloseService, RecalcService } from "../../src/modules/rankings/index.js";
import { rowsOfSnapshot, writeSnapshot } from "../../src/modules/rankings/snapshots.js";
import { createTestApp } from "../support/app.js";
import { tokenFor, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { after, prepareCalls, RecordingRankings, type Season, SilentWaker } from "../payouts/correction-scene.js";
import { at, buybackScene, REGISTERED } from "../admin/buyback-scene.js";

const C = at("2027-12-20T15:00:00Z");
const BASE = 10_000_000;

/**
 * O histórico do jogador (`GET /me/history`; F15, T8; Conta e login, critério 15; Rankings 21): a temporada 2027 do
 * cenário da recompra, encerrada pela rota, e depois a 2028 preparada.
 */
describe("histórico do jogador (F15, T8)", () => {
  const t = useTestDatabase(20);
  const clock = new FixedClock(REGISTERED);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  const scene = buybackScene(() => t.db, () => app, clock, 2027);
  const w = { ana: 0, bia: 0, caio: 0 };
  let s: Season;

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
    });
    await scene.init();
    await t.db.update(seasons).set({ status: "closed", closedAt: at("2026-12-20T15:00:00Z") }).where(ne(seasons.status, "closed"));

    s = await scene.newSeason();
    await t.db.update(seasons).set({ ipoOpensAt: at("2027-03-28T19:00:00Z") }).where(eq(seasons.id, s.seasonId));
    w.caio = await scene.player(s);
    w.ana = await scene.player(s);
    w.bia = await scene.player(s, BASE, "blocked");
    // Ana: 1.000 FLA3 a R$ 35,10; com o título (R$ 39,40) e a recompra (R$ 59,10), R$ 163.400,00 (2ª, atrás de Caio)
    await scene.buyAt(s, w.ana, "FLA3", 1_000, 3_510, at("2027-05-01T15:00:00Z"));
    await scene.buy(s, w.caio, "FLA3", 3_000);
    await scene.seasonEnd(s);

    // a tarefa fecha março a julho com Bia bloqueada (fora desses rankings); depois ela é desbloqueada
    const close = app.get(CloseService, { strict: false });
    await close.runOnce(at("2027-08-01T03:30:00Z"));
    await app.get(RecalcService, { strict: false }).processRecalcRequests(at("2027-08-01T03:31:00Z"));
    await t.db.update(users).set({ status: "active" }).where(eq(users.id, await userOf(w.bia)));

    expect((await scene.close(s.seasonId, REGISTERED)).errors).toEqual([]);
    await scene.approveAll(after(REGISTERED, 30));
    const res = await adminCall("POST", `/admin/seasons/${s.seasonId}/close`, { confirmYear: 2027 }, C);
    expect(res.statusCode).toBe(200);
  });
  afterAll(async () => {
    await app?.get(SettleCreditsService, { strict: false }).whenIdle();
    await app?.close();
  });

  async function adminCall(method: "GET" | "POST", url: string, payload?: object, now: Date = after(C, 60)) {
    clock.set(now);
    const token = await scene.admin.tokenWith({ at: now });
    return app.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${token}` } });
  }
  async function userOf(walletId: number): Promise<string> {
    return (await t.db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!.userId!;
  }
  async function historyOf(walletId: number, now: Date = after(C, 120)) {
    clock.set(now);
    const userId = await userOf(walletId);
    const { rows } = await t.db.execute(sql`select subject from futbolsa.auth_identities where user_id = ${userId}`);
    const token = await tokenFor({ subject: String(rows[0]!.subject), at: now });
    const res = await app.inject({ method: "GET", url: "/me/history", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    return historyResponseSchema.parse(res.json());
  }
  /** A posição da carteira na versão atual de cada ranking mensal, pelo banco. */
  async function monthPositions(walletId: number) {
    const heads = await t.db
      .select()
      .from(rankingSnapshots)
      .where(and(eq(rankingSnapshots.seasonId, s.seasonId), eq(rankingSnapshots.period, "month")))
      .orderBy(asc(rankingSnapshots.periodKey), sql`${rankingSnapshots.version} desc`);
    const out: Array<{ month: string; position: number }> = [];
    const seen = new Set<string>();
    for (const h of heads) {
      if (seen.has(h.periodKey)) continue;
      seen.add(h.periodKey);
      const [row] = await t.db.select().from(rankingRows).where(and(eq(rankingRows.snapshotId, h.id), eq(rankingRows.walletId, walletId)));
      if (row) out.push({ month: h.periodKey, position: row.position });
    }
    return out;
  }

  it("conta 15: o histórico mostra 2027 com R$ 163.400,00, +63,4% e 2º, e as posições mensais", async () => {
    const { seasons: list } = await historyOf(w.ana);
    expect(list).toHaveLength(1);
    const [y2027] = list;
    expect(y2027).toMatchObject({ year: 2027, finalEquity: 16_340_000, base: BASE, position: 2 });
    // o retorno exato sai de final/base na tela: +63,40%
    expect(((y2027!.finalEquity - y2027!.base) * 10_000) / y2027!.base).toBe(6_340);
    // Ana entrou em 01/04: de abril a dezembro, um ranking por mês
    expect(y2027!.months.map((m) => m.month)).toEqual(["2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"]);
    expect(y2027!.months).toEqual(await monthPositions(w.ana));
  });

  it("o mês em que o jogador não apareceu (bloqueado no fechamento) não tem posição", async () => {
    const [y2027] = (await historyOf(w.bia)).seasons;
    // bloqueada de março a julho: só de agosto em diante, e no anual (já desbloqueada no encerramento)
    expect(y2027!.months.map((m) => m.month)).toEqual(["2027-08", "2027-09", "2027-10", "2027-11", "2027-12"]);
    expect(y2027!.position).not.toBeNull();
  });

  it("o histórico usa a versão atual de um ranking mensal recalculado", async () => {
    const [v1] = await t.db
      .select()
      .from(rankingSnapshots)
      .where(and(eq(rankingSnapshots.seasonId, s.seasonId), eq(rankingSnapshots.period, "month"), eq(rankingSnapshots.periodKey, "2027-06")));
    const rows = await withTransaction(t.db, async (tx) => rowsOfSnapshot(tx, v1!.id));
    // a versão 2 de junho troca Ana e Caio de lugar
    const swapped = rows.map((r) => (r.walletId === w.ana ? { ...r, position: 1 } : r.walletId === w.caio ? { ...r, position: 2 } : r));
    await withTransaction(t.db, (tx) =>
      writeSnapshot(tx, { seasonId: s.seasonId, period: "month", periodKey: "2027-06", closedAt: v1!.closedAt, botsIncluded: v1!.botsIncluded, version: 2, reason: "pagamento", createdAt: after(C, 1) }, swapped),
    );
    const [y2027] = (await historyOf(w.ana)).seasons;
    expect(y2027!.months.find((m) => m.month === "2027-06")).toEqual({ month: "2027-06", position: 1 });
    expect((await historyOf(w.caio)).seasons[0]!.months.find((m) => m.month === "2027-06")).toEqual({ month: "2027-06", position: 2 });
  });

  it("rankings 21: com 2027 encerrada e 2028 aberta, o histórico mostra os rankings de 2027", async () => {
    const created = await adminCall("POST", "/admin/seasons", { year: 2028 });
    expect(created.statusCode).toBe(201);
    const next = created.json().id as number;
    await t.db.update(seasons).set({ status: "trading", ipoOpensAt: at("2028-03-27T19:00:00Z") }).where(eq(seasons.id, next));
    const { seasons: list } = await historyOf(w.ana, at("2028-04-10T15:00:00Z"));
    expect(list.map((x) => x.year)).toEqual([2027]);
    expect(list[0]).toMatchObject({ finalEquity: 16_340_000, position: 2 });
    // o ranking oficial de 2027 continua lá, sem mudar
    const official = await adminCall("GET", "/rankings/season/2027", undefined, at("2028-04-10T15:00:00Z"));
    expect(official.statusCode).toBe(200);
    expect(official.json()).toMatchObject({ periodKey: "2027", version: 1, closedAt: C.toISOString() });
  });

  it("sem temporada encerrada, o histórico vem vazio", async () => {
    const [user] = await t.db.select({ id: users.id }).from(users).where(eq(users.id, scene.admin.id));
    expect(user).toBeDefined();
    clock.set(after(C, 120));
    const res = await app.inject({ method: "GET", url: "/me/history", headers: { authorization: `Bearer ${await scene.admin.tokenWith({ at: after(C, 120) })}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seasons: [] });
  });
});
