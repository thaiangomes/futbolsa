import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botsViewSchema, patchBotsResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, bots, orders, seasons, wallets } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent, assertOpenOrdersCounter, assertReservesMatchOrders, assertSharesConserved } from "../support/invariants.js";
import { closeWindow, entryWorld, reopenWindow, type EntryWorld } from "../entry/support.js";
import { giveShares, orderService, syncTotalShares } from "../market/order-helpers.js";

// F14, T10: ligar e desligar bots (Admin 29, 30, 31 e 33).

const TUESDAY = new Date("2027-04-06T18:00:00Z");

describe("bots ao vivo: ligar e desligar", () => {
  const database = useTestDatabase(20);
  const clock = new FixedClock(TUESDAY);
  let app: NestFastifyApplication;
  let world: EntryWorld;
  let admin: TestAccount;

  const auth = async () => bearer(await admin.tokenWith({ at: clock.now() }));
  const patch = async (counts: object, reason?: string) =>
    app.inject({ method: "PATCH", url: "/admin/bots", payload: { counts, ...(reason ? { reason } : {}) }, headers: await auth() });
  const view = async () => botsViewSchema.parse((await app.inject({ method: "GET", url: "/admin/bots", headers: await auth() })).json());
  const profileOf = async (profile: string) => (await view()).profiles.find((p) => p.profile === profile)!;
  const setStatus = (status: string) => database.db.update(seasons).set({ status }).where(eq(seasons.id, world.seasonId));
  const walletOfBot = async (botId: number) => (await database.db.select().from(wallets).where(and(eq(wallets.seasonId, world.seasonId), eq(wallets.botId, botId))))[0];

  beforeAll(async () => {
    world = await entryWorld(database.db, { status: "ipo_open", settled: false, traded: false });
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin" });
  });
  afterAll(async () => {
    await assertLedgerConsistent(database.db, world.seasonId);
    await assertSharesConserved(database.db, world.seasonId);
    await assertOpenOrdersCounter(database.db, world.seasonId);
    await assertReservesMatchOrders(database.db, world.seasonId);
    await app.close();
  });

  it("admin 31: jogador comum não acessa as rotas de bots", async () => {
    // o token de teste vale perto de T0; o relógio volta para terça no fim
    clock.set(new Date(TOKEN_T0.getTime() + 60_000));
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/bots" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "PATCH", url: "/admin/bots", payload: { counts: { momentum: 0 } } }, { okStatus: 200 });
    clock.set(TUESDAY);
  });

  it("com a temporada em preparação, ligar só marca ativo: o bot não ganha carteira até a abertura do IPO", async () => {
    await setStatus("preparing");
    const res = await patch({ aleatorio: 2 });
    expect(res.statusCode).toBe(200);
    const created = patchBotsResponseSchema.parse(res.json()).created;
    expect(created).toHaveLength(2);
    for (const id of created) expect(await walletOfBot(id)).toBeUndefined();
    expect((await profileOf("aleatorio")).active).toBe(2);
    await patch({ aleatorio: 0 });
    await setStatus("ipo_open");
  });

  it("bot ligado com o IPO aberto ganha R$ 100.000,00 (carteira de IPO) e o registro guarda a mudança", async () => {
    const res = await patch({ momentum: 25 }, "povoando o mercado");
    expect(res.statusCode).toBe(200);
    const ids = patchBotsResponseSchema.parse(res.json()).created;
    expect(ids).toHaveLength(25);
    const w = await walletOfBot(ids[0]!);
    expect(w).toMatchObject({ cash: 10_000_000, entryMode: "ipo", ownerType: "bot" });
    const p = await profileOf("momentum");
    expect(p).toMatchObject({ active: 25, inactive: 0 });
    expect(p.bots[0]).toMatchObject({ hasWallet: true, equity: 10_000_000 });
    const [log] = (await database.db.select().from(adminLog).where(eq(adminLog.action, "bots.update"))).slice(-1);
    expect(log!.reason).toBe("povoando o mercado");
    expect(log!.after).toMatchObject({ profile: "momentum", active: 25 });
  });

  it("admin 29: de 25 bots de momentum ativos para 10, os 15 de id maior param, têm as ordens canceladas com bot_off e mantêm as carteiras; voltar para 25 religa os mesmos", async () => {
    await setStatus("trading");
    const all = await database.db.select().from(bots).where(eq(bots.profile, "momentum")).orderBy(asc(bots.id));
    const fla = world.clubIds.get("FLA3")!;
    const { service } = orderService(database.db);
    // os 3 de id maior têm ações e ordens de venda abertas
    for (const b of all.slice(-3)) {
      const w = await walletOfBot(b.id);
      await giveShares(database.db, w!.id, fla, 10, 2400);
      await syncTotalShares(database.db, world.seasonId);
      const r = await service.place({ seasonId: world.seasonId, ticker: "FLA3", walletId: w!.id, actor: "bot", side: "sell", type: "limit", quantity: 5, limitPrice: 2500, now: TUESDAY });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
    const walletsBefore = (await database.db.select().from(wallets).where(eq(wallets.seasonId, world.seasonId))).length;

    const res = await patch({ momentum: 10 });
    expect(res.statusCode).toBe(200);
    const off = patchBotsResponseSchema.parse(res.json()).turnedOff;
    expect(off).toEqual(all.slice(10).map((b) => b.id));
    const after = await profileOf("momentum");
    expect(after).toMatchObject({ active: 10, inactive: 15 });
    const cancelled = await database.db.select().from(orders).where(eq(orders.status, "cancelled"));
    expect(cancelled.filter((o) => o.cancelReason === "bot_off")).toHaveLength(3);
    for (const id of off) expect(await walletOfBot(id)).toBeDefined();
    expect((await database.db.select().from(wallets).where(eq(wallets.seasonId, world.seasonId))).length).toBe(walletsBefore);

    // voltar para 25 religa os mesmos 15, sem bot nem carteira nova
    const back = patchBotsResponseSchema.parse((await patch({ momentum: 25 })).json());
    expect(back.turnedOn).toEqual(off);
    expect(back.created).toEqual([]);
    expect(await profileOf("momentum")).toMatchObject({ active: 25, inactive: 0 });
    expect((await database.db.select().from(wallets).where(eq(wallets.seasonId, world.seasonId))).length).toBe(walletsBefore);
  });

  it("admin 30: bot ligado depois do IPO recebe a carteira índice (pela F11); depois da janela, bot novo é recusado com bot_entry_closed", async () => {
    const res = await patch({ dividendos: 1 });
    expect(res.statusCode).toBe(200);
    const [id] = patchBotsResponseSchema.parse(res.json()).created;
    expect(await walletOfBot(id!)).toMatchObject({ entryMode: "index", ownerType: "bot" });

    const windowClosedAt = await closeWindow(database.db, world.seasonId);
    clock.set(new Date(windowClosedAt.getTime() + 3600_000));
    const botsBefore = (await database.db.select().from(bots)).length;
    const closed = await patch({ torcedor: 2 });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("bot_entry_closed");
    expect((await database.db.select().from(bots)).length).toBe(botsBefore);
    // religar quem já tem carteira continua valendo
    await patch({ dividendos: 0 });
    expect(patchBotsResponseSchema.parse((await patch({ dividendos: 1 })).json()).turnedOn).toEqual([id]);
    await reopenWindow(database.db, world.seasonId);
    clock.set(TUESDAY);
  });

  it("a contagem vai de 0 a 200 e perfil desconhecido é recusado", async () => {
    expect((await patch({ momentum: 201 })).statusCode).toBe(400);
    expect((await patch({ momentum: -1 })).statusCode).toBe(400);
    expect((await patch({ fofoqueiro: 1 })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
  });

  it("dois admins criando o mesmo número de bots de um perfil vazio ao mesmo tempo terminam com esse número, sem passar dele", async () => {
    const [a, b] = await Promise.all([patch({ captura: 5 }), patch({ captura: 5 })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(await profileOf("captura")).toMatchObject({ active: 5, inactive: 0 });
    expect((await database.db.select().from(bots).where(eq(bots.profile, "captura"))).length).toBe(5);
  });

  it("dois admins mudando o mesmo perfil ao mesmo tempo terminam com um dos dois números, nunca uma mistura", async () => {
    for (let i = 0; i < 6; i++) {
      const [a, b] = await Promise.all([patch({ momentum: 3 + i }), patch({ momentum: 20 - i })]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const active = (await profileOf("momentum")).active;
      expect([3 + i, 20 - i]).toContain(active);
      const open = await database.db.select().from(orders).where(eq(orders.status, "open"));
      const inactiveBots = new Set((await database.db.select().from(bots).where(eq(bots.active, false))).map((r) => r.id));
      const wallet = new Map((await database.db.select().from(wallets)).map((w) => [w.id, w.botId]));
      for (const o of open) expect(inactiveBots.has(wallet.get(o.walletId) ?? -1), "ordem aberta de bot desligado").toBe(false);
    }
  });
});
