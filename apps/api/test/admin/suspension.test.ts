import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { publicSeasonSchema, suspensionStateSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Tx } from "../../src/infra/db/index.js";
import { adminLog, orders, seasonClubs, seasons } from "../../src/infra/db/schema/index.js";
import { MarketPort, type RefreshReason } from "../../src/modules/admin/results/ports.js";
import { SuspensionService } from "../../src/modules/admin/suspension/suspension.service.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openPlayerWallets, seedSeason } from "../support/fixtures.js";

class RecordingMarket extends MarketPort {
  readonly cancelled: string[][] = [];
  readonly refreshes: Array<{ tickers: string[]; reason: RefreshReason }> = [];
  async cancelHouseQuotes(_tx: Tx, tickers: readonly string[]): Promise<void> {
    this.cancelled.push([...tickers]);
  }
  async requestRefresh(_tx: Tx, tickers: readonly string[], reason: RefreshReason): Promise<void> {
    this.refreshes.push({ tickers: [...tickers], reason });
  }
}

describe("suspensão da negociação", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  const market = new RecordingMarket();
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let tickers: string[];
  let service: SuspensionService;

  beforeAll(async () => {
    app = await createTestApp({
      db: database.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(MarketPort).useValue(market),
    });
    admin = await createAccount(database.db, { role: "admin" });
    ({ seasonId, clubIds } = await seedSeason(database.db));
    tickers = [...clubIds.keys()];
    await listClubs(database.db, seasonId, clubIds, tickers);
    service = app.get(SuspensionService, { strict: false });
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    market.cancelled.length = 0;
    market.refreshes.length = 0;
    await database.db.update(seasonClubs).set({ suspendedReason: null });
    await database.db.update(seasons).set({ suspendedReason: null });
  });

  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(admin.token), ...(payload ? { payload } : {}) });
  const state = async () => suspensionStateSchema.parse((await call("GET", "/admin/suspensions")).json());
  const logs = (action: string) => database.db.select().from(adminLog).where(eq(adminLog.action, action));

  it("admin 31: jogador comum não acessa as rotas de suspensão", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/suspensions" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "POST", url: "/admin/suspensions", payload: { ticker: "FLA3", reason: "teste de acesso" } });
    await expectAdminOnly(app, database.db, { method: "DELETE", url: "/admin/suspensions/FLA3" });
    await expectAdminOnly(app, database.db, { method: "DELETE", url: "/admin/suspensions" });
  });

  it("admin 23: clube suspenso guarda o motivo e os outros clubes seguem sem suspensão", async () => {
    const res = await call("POST", "/admin/suspensions", { ticker: "FLA3", reason: "estádio interditado" });
    expect(res.statusCode).toBe(200);
    expect(suspensionStateSchema.parse(res.json())).toEqual({ market: null, clubs: [{ ticker: "FLA3", reason: "estádio interditado" }] });
    const rows = await database.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, seasonId));
    expect(rows.filter((r) => r.suspendedReason !== null).map((r) => r.clubId)).toEqual([clubIds.get("FLA3")]);
    // todos os jogadores veem o motivo
    const pub = publicSeasonSchema.parse((await app.inject({ method: "GET", url: "/season" })).json());
    expect(pub.suspendedClubs).toEqual([{ ticker: "FLA3", reason: "estádio interditado" }]);
    const [log] = (await logs("suspension.set")).slice(-1);
    expect(log).toMatchObject({ actorId: admin.id, targetType: "club", targetId: "FLA3", reason: "estádio interditado", before: { reason: null }, after: { reason: "estádio interditado" } });
  });

  it("admin 24: as ordens dos jogadores continuam no livro e só as cotações da casa são pedidas para cancelar (pela porta)", async () => {
    const [wallet] = await openPlayerWallets(database.db, seasonId, 1);
    const [order] = await database.db
      .insert(orders)
      .values({
        seasonId,
        clubId: clubIds.get("FLA3")!,
        walletId: wallet!,
        side: "buy",
        type: "limit",
        quantity: 10,
        limitPrice: 4000,
        reservedCash: 40_000,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })
      .returning();
    await call("POST", "/admin/suspensions", { ticker: "FLA3", reason: "problema no estádio" });
    expect(market.cancelled).toEqual([["FLA3"]]);
    const [after] = await database.db.select().from(orders).where(eq(orders.id, order!.id));
    expect(after).toMatchObject({ status: "open", cancelReason: null });
  });

  it("suspensão sem motivo ou com ticker que não está listado é recusada", async () => {
    expect((await call("POST", "/admin/suspensions", { ticker: "FLA3" })).statusCode).toBe(400);
    expect((await call("POST", "/admin/suspensions", { ticker: "FLA3", reason: "  " })).statusCode).toBe(400);
    const unknown = await call("POST", "/admin/suspensions", { ticker: "ZZZ3", reason: "clube que não existe" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("club_not_listed");
    expect((await state()).clubs).toEqual([]);
    expect(market.cancelled).toEqual([]);
  });

  it("suspender o que já está suspenso é erro; retomar o que não está também", async () => {
    await call("POST", "/admin/suspensions", { ticker: "PAL3", reason: "primeira suspensão" });
    const again = await call("POST", "/admin/suspensions", { ticker: "PAL3", reason: "segunda suspensão" });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("already_suspended");
    const notSuspended = await call("DELETE", "/admin/suspensions/FLA3");
    expect(notSuspended.statusCode).toBe(409);
    expect(notSuspended.json().code).toBe("not_suspended");
    expect((await call("DELETE", "/admin/suspensions")).json().code).toBe("not_suspended");
  });

  it("retomar zera o motivo, pede a reposição da casa e registra", async () => {
    await call("POST", "/admin/suspensions", { ticker: "FLA3", reason: "estádio interditado" });
    market.refreshes.length = 0;
    const res = await call("DELETE", "/admin/suspensions/FLA3");
    expect(res.statusCode).toBe(200);
    expect(suspensionStateSchema.parse(res.json())).toEqual({ market: null, clubs: [] });
    expect(market.refreshes).toEqual([{ tickers: ["FLA3"], reason: "resume" }]);
    const [log] = (await logs("suspension.clear")).slice(-1);
    expect(log).toMatchObject({ targetId: "FLA3", before: { reason: "estádio interditado" }, after: { reason: null } });
  });

  it("suspender o mercado todo cancela as cotações da casa de todos os clubes; retomar pede a reposição de todos", async () => {
    const res = await call("POST", "/admin/suspensions", { reason: "falha na fonte dos placares" });
    expect(res.statusCode).toBe(200);
    expect(suspensionStateSchema.parse(res.json()).market).toEqual({ reason: "falha na fonte dos placares" });
    expect(market.cancelled).toHaveLength(1);
    expect(market.cancelled[0]).toEqual([...tickers].sort());
    const [season] = await database.db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(season!.suspendedReason).toBe("falha na fonte dos placares");
    expect(publicSeasonSchema.parse((await app.inject({ method: "GET", url: "/season" })).json()).season?.suspendedReason).toBe("falha na fonte dos placares");
    const again = await call("POST", "/admin/suspensions", { reason: "outra vez" });
    expect(again.statusCode).toBe(409);

    market.refreshes.length = 0;
    const resumed = await call("DELETE", "/admin/suspensions");
    expect(resumed.statusCode).toBe(200);
    expect(suspensionStateSchema.parse(resumed.json()).market).toBeNull();
    expect(market.refreshes).toEqual([{ tickers: [...tickers].sort(), reason: "resume" }]);
    expect((await logs("suspension.set")).some((l) => l.targetType === "market")).toBe(true);
    expect((await logs("suspension.clear")).some((l) => l.targetType === "market")).toBe(true);
  });

  it("retomar o mercado não retoma o clube suspenso à parte", async () => {
    await call("POST", "/admin/suspensions", { ticker: "FLA3", reason: "estádio interditado" });
    await call("POST", "/admin/suspensions", { reason: "falha na fonte dos placares" });
    await call("DELETE", "/admin/suspensions");
    const s = await state();
    expect(s.market).toBeNull();
    expect(s.clubs).toEqual([{ ticker: "FLA3", reason: "estádio interditado" }]);
  });

  it("uma suspensão e uma retomada ao mesmo tempo não dão deadlock (50 repetições)", async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 50; i++) {
      const results = await Promise.allSettled([
        service.suspend(admin.id, { reason: `mercado ${i}` }),
        service.resume(admin.id, undefined),
        service.suspend(admin.id, { ticker: "FLA3", reason: `clube ${i}` }),
        service.resume(admin.id, "FLA3"),
        service.suspend(admin.id, { ticker: "VAS3", reason: `outro ${i}` }),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          // só recusas de regra (já suspenso, não suspenso): nunca erro de banco
          expect((r.reason as { code?: string }).code).toMatch(/^(already_suspended|not_suspended)$/);
          outcomes.push((r.reason as { code: string }).code);
        }
      }
      await service.resume(admin.id, undefined).catch(() => undefined);
      await service.resume(admin.id, "FLA3").catch(() => undefined);
      await service.resume(admin.id, "VAS3").catch(() => undefined);
    }
    expect(outcomes.length).toBeGreaterThan(0);
  }, 120_000);

  it("sem temporada em andamento, suspender é recusado", async () => {
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, seasonId));
    const res = await call("POST", "/admin/suspensions", { ticker: "FLA3", reason: "teste sem temporada" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("no_season");
    await database.db.update(seasons).set({ status: "preparing" }).where(eq(seasons.id, seasonId));
  });
});
