import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BOT_PROFILE_NAMES } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { bots, clubs, ipoBids, matches, orders, seasonClubs, seasonRules, seasons, wallets } from "../../src/infra/db/schema/index.js";
import { IpoBidsService } from "../../src/modules/ipo/bids.service.js";
import { BotSnapshotService } from "../../src/modules/admin/bots/market-snapshot.js";
import { AttentionClubs, PartialScores } from "../../src/modules/admin/bots/partial-scores.js";
import { BotRunner, BotRunnerSettings } from "../../src/modules/admin/bots/runner.js";
import { createTestApp } from "../support/app.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets, rng } from "../support/fixtures.js";
import { assertLedgerConsistent, assertOpenOrdersCounter, assertReservesMatchOrders, assertSharesConserved } from "../support/invariants.js";
import { entryWorld, type EntryWorld } from "../entry/support.js";
import { giveShares, orderService, syncTotalShares } from "../market/order-helpers.js";

// F14, T12: a tarefa dos bots (Admin 29 e 30; "bot ligado antes do fechamento participa do IPO").

const TUESDAY = new Date("2027-04-06T18:00:00Z");
const CASH = 10_000_000;

describe("tarefa dos bots", () => {
  const database = useTestDatabase(20);
  const clock = new FixedClock(TUESDAY);
  let app: NestFastifyApplication;
  let world: EntryWorld;
  let runner: BotRunner;

  const newBot = async (profile: string, active = true) => (await database.db.insert(bots).values({ profile, active }).returning({ id: bots.id }))[0]!.id;
  const botWallet = async (botId: number, cash = CASH) => (await openWallets(database.db, world.seasonId, [{ type: "bot", botId }], cash))[0]!;
  const setStatus = (status: string) => database.db.update(seasons).set({ status }).where(eq(seasons.id, world.seasonId));

  beforeAll(async () => {
    // 4 clubes e a liga completa entre eles (uma rodada jogada, a outra por disputar)
    world = await entryWorld(database.db, { clubs: 4, status: "ipo_open", settled: false, traded: false });
    await database.db.insert(seasonRules).values({
      seasonId: world.seasonId, aPerPoint: 10, bPerPoint: 5, aPlacement: Array.from({ length: 20 }, (_, i) => 500 - i * 20), promotionPerShare: 200, promotionSlots: 4, buybackMultipleBp: 15000,
    });
    const id = (t: string) => world.clubIds.get(t)!;
    const [a, b, c, d] = world.tickers as [string, string, string, string];
    await database.db.insert(matches).values([
      { seasonId: world.seasonId, competition: "brasileirao-a", round: 1, homeClubId: id(c), awayClubId: id(d), kickoff: new Date("2027-03-30T22:00:00Z"), finishedAt: new Date("2027-03-31T00:00:00Z"), homeGoals: 2, awayGoals: 1, status: "finished" },
      { seasonId: world.seasonId, competition: "brasileirao-a", round: 2, homeClubId: id(d), awayClubId: id(c), kickoff: new Date("2027-12-01T22:00:00Z"), status: "scheduled" },
      { seasonId: world.seasonId, competition: "brasileirao-a", round: 3, homeClubId: id(a), awayClubId: id(c), kickoff: new Date("2027-12-08T22:00:00Z"), status: "scheduled" },
      { seasonId: world.seasonId, competition: "brasileirao-a", round: 3, homeClubId: id(b), awayClubId: id(d), kickoff: new Date("2027-12-08T22:00:00Z"), status: "scheduled" },
    ]);
    // a faixa do IPO e as datas, para as ofertas
    await database.db.update(seasonClubs).set({ bandFloor: 1500, bandCenter: 2400, bandCeiling: 3400 }).where(eq(seasonClubs.seasonId, world.seasonId));
    await database.db.update(seasons).set({ ipoOpensAt: new Date("2027-04-01T13:00:00Z"), ipoClosesAt: new Date("2027-04-10T13:00:00Z") }).where(eq(seasons.id, world.seasonId));
    app = await createTestApp({ db: database.db, clock });
    runner = app.get(BotRunner);
  });
  afterAll(async () => {
    await assertLedgerConsistent(database.db, world.seasonId);
    await assertSharesConserved(database.db, world.seasonId);
    await assertOpenOrdersCounter(database.db, world.seasonId);
    await assertReservesMatchOrders(database.db, world.seasonId);
    await app.close();
  });

  it("o ritmo: 0,25 a cada 3 horas em rodadas de 15 minutos dá cerca de 2,1% por rodada, e vem da configuração", () => {
    expect(runner.chancePerRound).toBeCloseTo((0.25 * 15) / 180, 10);
    const settings = app.get(BotRunnerSettings);
    expect(settings.config).toEqual({ tickMinutes: 15, activityPer3h: 0.25 });
  });

  it("com o IPO aberto, o bot ligado e sem carteira ganha R$ 100.000,00 e oferta uma vez; a segunda rodada não muda nada", async () => {
    const ids: number[] = [];
    for (const profile of BOT_PROFILE_NAMES) ids.push(await newBot(profile));
    const first = await runner.runOnce(TUESDAY, rng(1));
    expect(first).toMatchObject({ skipped: false, status: "ipo_open", wallets: 9 });
    expect(first.bids).toBeGreaterThan(0);
    for (const id of ids) {
      const [w] = await database.db.select().from(wallets).where(and(eq(wallets.seasonId, world.seasonId), eq(wallets.botId, id)));
      expect(w).toMatchObject({ entryMode: "ipo" });
    }
    const bids = await database.db.select().from(ipoBids).where(eq(ipoBids.seasonId, world.seasonId));
    expect(bids.length).toBe(first.bids);
    const second = await runner.runOnce(TUESDAY, rng(1));
    expect(second).toMatchObject({ bids: 0, wallets: 0 });
    expect((await database.db.select().from(ipoBids).where(eq(ipoBids.seasonId, world.seasonId))).length).toBe(bids.length);
  });

  it("na negociação, as intenções viram ordens pelo placeOrder e as recusas são contadas sem parar a rodada", async () => {
    // cancela as ofertas (devolve a reserva pelo serviço) e abre a negociação, com ações nas carteiras
    const ipoService = app.get(IpoBidsService);
    for (const bid of await database.db.select({ w: ipoBids.walletId, t: clubs.ticker }).from(ipoBids).innerJoin(clubs, eq(clubs.id, ipoBids.clubId))) await ipoService.cancel(bid.w, bid.t!);
    await setStatus("trading");
    const botWallets = await database.db.select().from(wallets).where(and(eq(wallets.seasonId, world.seasonId), eq(wallets.ownerType, "bot")));
    for (const w of botWallets) {
      await giveShares(database.db, w.id, world.clubIds.get(world.tickers[0]!)!, 20, 2400).catch(() => undefined);
      await giveShares(database.db, w.id, world.clubIds.get(world.tickers[2]!)!, 20, 2400).catch(() => undefined);
    }
    await syncTotalShares(database.db, world.seasonId);
    // chance 1: todos agem
    const always = () => 0;
    let placed = 0;
    let refused = 0;
    for (let round = 0; round < 3; round++) {
      const report = await runner.runOnce(new Date(TUESDAY.getTime() + round * 15 * 60_000), always);
      expect(report.status).toBe("trading");
      expect(report.acted).toBe(9);
      placed += report.placed;
      refused += Object.values(report.refused).reduce((a, b) => a + b, 0);
    }
    expect(placed + refused).toBeGreaterThan(0);
    const open = await database.db.select().from(orders).where(and(eq(orders.seasonId, world.seasonId), eq(orders.status, "open")));
    expect(open.length).toBeGreaterThan(0);
    await assertReservesMatchOrders(database.db, world.seasonId);
  });

  it("chance zero: ninguém age; bot desligado não age e as ordens que sobraram são canceladas na varredura", async () => {
    const quiet = await runner.runOnce(TUESDAY, () => 1);
    expect(quiet).toMatchObject({ acted: 0, placed: 0 });
    const [victim] = await database.db.select().from(bots).where(eq(bots.profile, "momentum"));
    const [w] = await database.db.select().from(wallets).where(eq(wallets.botId, victim!.id));
    const hadOpen = await database.db.select().from(orders).where(and(eq(orders.walletId, w!.id), eq(orders.status, "open")));
    if (hadOpen.length === 0) {
      // garante uma ordem aberta para a varredura
      const { service } = orderService(database.db);
      const r = await service.place({ seasonId: world.seasonId, ticker: world.tickers[0]!, walletId: w!.id, actor: "bot", side: "sell", type: "limit", quantity: 3, limitPrice: 2600, now: TUESDAY });
      expect(r.ok).toBe(true);
    }
    await database.db.update(bots).set({ active: false }).where(eq(bots.id, victim!.id));
    const report = await runner.runOnce(TUESDAY, () => 0);
    expect(report.swept).toBeGreaterThan(0);
    expect(report.acted).toBe(8);
    const left = await database.db.select().from(orders).where(and(eq(orders.walletId, w!.id), eq(orders.status, "open")));
    expect(left).toEqual([]);
    const cancelled = await database.db.select().from(orders).where(and(eq(orders.walletId, w!.id), eq(orders.cancelReason, "bot_off")));
    expect(cancelled.length).toBeGreaterThan(0);
    await database.db.update(bots).set({ active: true }).where(eq(bots.id, victim!.id));
  });

  it("admin 29: a ordem montada antes do desligamento é recusada pelo market com bot_inactive", async () => {
    const [victim] = await database.db.select().from(bots).where(eq(bots.profile, "dividendos"));
    await database.db.update(bots).set({ active: false }).where(eq(bots.id, victim!.id));
    const gate = (runner as unknown as { refuseInactive(tx: { db: unknown }, botId: number): Promise<unknown> }).refuseInactive.bind(runner);
    const outcome = await withTransaction(database.db, (tx) => gate(tx, victim!.id));
    expect(outcome).toEqual({ ok: false, code: "bot_inactive" });
    await database.db.update(bots).set({ active: true }).where(eq(bots.id, victim!.id));
    expect(await withTransaction(database.db, (tx) => gate(tx, victim!.id))).toBeUndefined();
  });

  it("com a temporada em trading_ended nenhum bot age; duas rodadas ao mesmo tempo viram uma", async () => {
    const [a, b] = await Promise.all([runner.runOnce(TUESDAY, () => 0), runner.runOnce(TUESDAY, () => 0)]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
    await setStatus("trading_ended");
    const report = await runner.runOnce(TUESDAY, () => 0);
    expect(report).toMatchObject({ acted: 0, placed: 0, bids: 0 });
    await setStatus("trading");
  });

  it("item 23: com um jogo em andamento a visão dos bots enxerga o placar parcial; sem ele, o valor justo é o de sempre", async () => {
    const snapshots = app.get(BotSnapshotService);
    const [, , c, d] = world.tickers as [string, string, string, string];
    const normal = await snapshots.load(world.seasonId, TUESDAY);
    const spy = vi.spyOn(app.get(PartialScores), "at").mockReturnValue([{ home: c, away: d, homeGoals: 2, awayGoals: 0, minute: 70 }]);
    try {
      const vivo = await snapshots.load(world.seasonId, TUESDAY);
      expect(vivo.leagues.get(c)!.fairValue(c)).toBeGreaterThan(normal.leagues.get(c)!.fairValue(c));
      expect(vivo.leagues.get(d)!.fairValue(d)).toBeLessThan(normal.leagues.get(d)!.fairValue(d));
      const [a] = world.tickers as [string];
      expect(vivo.leagues.get(a)!.fairValue(a)).toBe(normal.leagues.get(a)!.fairValue(a)); // quem não joga não muda
    } finally {
      spy.mockRestore();
    }
    const depois = await snapshots.load(world.seasonId, TUESDAY);
    expect(depois.leagues.get(c)!.fairValue(c)).toBe(normal.leagues.get(c)!.fairValue(c));
  });

  it("item 23 (atenção no gol): com clubes em foco, os bots que olham para eles só negociam esses clubes; sem foco, olham o mercado todo", async () => {
    const [, , c, d] = world.tickers as [string, string, string, string];
    const novas = async (quando: Date, atencao: readonly string[]) => {
      const antes = (await database.db.select({ id: orders.id }).from(orders)).reduce((m, o) => Math.max(m, o.id), 0);
      const spy = vi.spyOn(app.get(AttentionClubs), "clubs").mockReturnValue(atencao);
      try {
        await runner.runOnce(quando, () => 0); // todos agem e todos olham para o foco, se houver
      } finally {
        spy.mockRestore();
      }
      const rows = await database.db.select({ id: orders.id, ticker: clubs.ticker }).from(orders).innerJoin(clubs, eq(clubs.id, orders.clubId));
      return new Set(rows.filter((o) => o.id > antes).map((o) => o.ticker));
    };
    const comFoco = await novas(new Date(TUESDAY.getTime() + 3 * 3_600_000), [c, d]);
    expect(comFoco.size).toBeGreaterThan(0);
    for (const ticker of comFoco) expect([c, d]).toContain(ticker);
    const semFoco = await novas(new Date(TUESDAY.getTime() + 4 * 3_600_000), []);
    expect([...semFoco].some((t) => ![c, d].includes(t!))).toBe(true);
    await assertReservesMatchOrders(database.db, world.seasonId);
  });
});
