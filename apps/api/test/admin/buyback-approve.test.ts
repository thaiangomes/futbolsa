import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { payoutCredits, positions, wallets } from "../../src/infra/db/schema/index.js";
import { ApproveService } from "../../src/modules/admin/payouts/approve.service.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SETTLE_BATCH, SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { settlingEventIds } from "../../src/modules/admin/payouts/settlement.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { after, CALLS, FlakyLedger, prepareCalls, RecordingRankings, RICH, type Season, SilentWaker, TOTAL } from "../payouts/correction-scene.js";
import { BUYBACKS, buybackScene, REGISTERED } from "./buyback-scene.js";

describe("aprovação e liquidação da recompra (F15, T4)", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(REGISTERED);
  const rankings = new RecordingRankings();
  const ledger = new FlakyLedger();
  let app: NestFastifyApplication;
  let approver: ApproveService;
  let settle: SettleCreditsService;
  const scene = buybackScene(() => t.db, () => app, clock);

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) =>
        withTestAuth(clock)(b)
          .overrideProvider(RankingsPort)
          .useValue(rankings)
          .overrideProvider(PortfolioLedger)
          .useValue(ledger)
          .overrideProvider(RefreshWaker)
          .useValue(new SilentWaker()),
    });
    approver = app.get(ApproveService, { strict: false });
    settle = app.get(SettleCreditsService, { strict: false });
    await scene.init();
  });
  afterAll(async () => {
    await settle?.whenIdle();
    await app?.close();
  });
  beforeEach(async () => {
    await settle.whenIdle();
    settle.batchSize = SETTLE_BATCH;
    ledger.failFrom = null;
    ledger.posts = 0;
    rankings.reset();
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  /** A temporada com a recompra fechada às 18h15 da final (D = REGISTERED). */
  async function closed(setup: (s: Season) => Promise<void>): Promise<Season> {
    const s = await scene.newSeason();
    await setup(s);
    await scene.seasonEnd(s);
    const summary = await scene.close(s.seasonId, REGISTERED);
    expect(summary.errors).toEqual([]);
    return s;
  }

  /** Aprova a recompra do clube e liquida. */
  async function approve(s: Season, ticker: string, now = after(REGISTERED, 30)) {
    clock.set(now);
    const event = await scene.buybackOf(s, ticker);
    const { results } = await approver.approve(scene.admin.id, { eventIds: [event.id] });
    return { event, outcome: results[0]!.outcome, settled: await settle.settleEvent(event.id) };
  }

  const heldOf = async (s: Season, ticker: string) => {
    const { rows } = await t.db.execute(sql`
      select coalesce(sum(p.shares), 0)::int as n from futbolsa.positions p join futbolsa.wallets w on w.id = p.wallet_id
      where w.season_id = ${s.seasonId} and p.club_id = ${scene.club(ticker)}`);
    return Number(rows[0]!.n);
  };

  it("dividendos 21: Ana com 1.200 FLA3 recebe R$ 70.920,00, fica sem FLA3 e o extrato mostra a venda a R$ 59,10", async () => {
    let ana = 0;
    const s = await closed(async (season) => {
      ana = await scene.player(season);
      await scene.buy(season, ana, "FLA3", 1_200);
    });
    const cash = await scene.cashOf(ana);
    const { event, outcome, settled } = await approve(s, "FLA3");
    expect(outcome).toBe("approved");
    expect(settled).toMatchObject({ credited: 1, amount: 7_092_000, stopped: null });
    expect(await scene.cashOf(ana)).toBe(cash + 7_092_000);
    expect(await scene.sharesOf(ana, "FLA3")).toBe(0);
    const [entry] = await scene.entriesOf(ana, ["buyback"]);
    expect(entry).toMatchObject({ kind: "buyback", clubId: scene.club("FLA3"), cashDelta: 7_092_000, sharesDelta: -1_200, price: BUYBACKS.FLA3, refType: "payout_event", refId: String(event.id) });
    expect(await scene.creditsOf(event.id)).toEqual([expect.objectContaining({ walletId: ana, amount: 7_092_000, entryId: entry!.id })]);
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("dividendos 22: a tesouraria com 500 FLA3 não recebe e fica sem FLA3; nenhuma conta tem FLA3", async () => {
    let ana = 0;
    let bruno = 0;
    const s = await closed(async (season) => {
      ana = await scene.player(season);
      bruno = await scene.player(season);
      await scene.buy(season, ana, "FLA3", 1_200);
      await scene.buy(season, bruno, "FLA3", TOTAL - 1_200 - 500);
    });
    expect(await scene.sharesOf(s.treasury, "FLA3")).toBe(500);
    const treasuryCash = await scene.cashOf(s.treasury);

    const { event, settled } = await approve(s, "FLA3");
    expect(settled).toMatchObject({ credited: 2, swept: 1 });
    expect(await scene.cashOf(s.treasury)).toBe(treasuryCash);
    expect(await scene.sharesOf(s.treasury, "FLA3")).toBe(0);
    expect(await heldOf(s, "FLA3")).toBe(0);
    const [swept] = await scene.entriesOf(s.treasury, ["buyback"]);
    expect(swept).toMatchObject({ cashDelta: 0, sharesDelta: -500, price: 0, realized: null, refId: String(event.id) });
    // a tesouraria não tem linha em payout_credits
    expect((await scene.creditsOf(event.id)).map((c) => c.walletId)).toEqual([ana, bruno]);
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([]);
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("dividendos 24: donos recebem R$ 0,00 e as ações somem", async () => {
    let ana = 0;
    const s = await closed(async (season) => {
      ana = await scene.player(season);
      await scene.buy(season, ana, "COR3", 300);
    });
    const cash = await scene.cashOf(ana);
    const { event, settled } = await approve(s, "COR3");
    expect(event.perShare).toBe(0);
    expect(settled).toMatchObject({ credited: 1, amount: 0, swept: 1 });
    expect(await scene.cashOf(ana)).toBe(cash);
    expect(await scene.sharesOf(ana, "COR3")).toBe(0);
    expect(await heldOf(s, "COR3")).toBe(0);
    const [entry] = await scene.entriesOf(ana, ["buyback"]);
    expect(entry).toMatchObject({ cashDelta: 0, sharesDelta: -300, price: 0, realized: -30_000 });
    expect(await scene.creditsOf(event.id)).toEqual([expect.objectContaining({ walletId: ana, amount: 0 })]);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("carteira 21: recompra de 1.200 a R$ 19,35 com −R$ 21.180,00 realizados e posição zerada", async () => {
    let ana = 0;
    const s = await closed(async (season) => {
      ana = await scene.player(season, RICH);
      await scene.buyAt(season, ana, "SAO3", 1_200, 3_700, after(REGISTERED, -60 * 24 * 60));
    });
    await approve(s, "SAO3");
    const [entry] = await scene.entriesOf(ana, ["buyback"]);
    expect(entry).toMatchObject({ cashDelta: 1_200 * 1_935, sharesDelta: -1_200, price: 1_935, realized: -2_118_000 });
    expect(await scene.positionOf(ana, "SAO3")).toMatchObject({ shares: 0, reservedShares: 0, cost: 0, realized: -2_118_000 });
  });

  it("rankings 23: a aprovação e a liquidação em lotes não mudam o patrimônio; aprovar duas vezes paga uma; bloqueado e bot recebem; conta excluída depois de D não recebe e as ações dela somem", async () => {
    const w = { ana: 0, bia: 0, bot: 0, caio: 0 };
    const s = await closed(async (season) => {
      w.ana = await scene.player(season);
      w.bia = await scene.player(season, RICH, "blocked");
      w.bot = await scene.bot(season);
      w.caio = await scene.player(season);
      await scene.buy(season, w.ana, "FLA3", 1_000);
      await scene.buy(season, w.bia, "FLA3", 200);
      await scene.buy(season, w.bot, "FLA3", 300);
      await scene.buy(season, w.caio, "FLA3", 400);
    });
    // Caio exclui a conta depois de D: as ações dele vão para a tesouraria (F5)
    await scene.deleteAccount(s, w.caio, after(REGISTERED, 10));
    expect(await scene.sharesOf(s.treasury, "FLA3")).toBe(TOTAL - 1_500);
    const cash = { ana: await scene.cashOf(w.ana), bia: await scene.cashOf(w.bia), bot: await scene.cashOf(w.bot) };
    const equity = async (when: Date) => new Map([...(await scene.equityAt(s, when))].map(([id, e]) => [id, e.equity]));
    const before = await equity(after(REGISTERED, 20));

    // a liquidação cai no meio: lotes de uma carteira, e o segundo lançamento falha
    settle.batchSize = 1;
    ledger.posts = 0;
    ledger.failFrom = 2;
    clock.set(after(REGISTERED, 30));
    const event = await scene.buybackOf(s, "FLA3");
    expect((await approver.approve(scene.admin.id, { eventIds: [event.id] })).results[0]!.outcome).toBe("approved");
    await expect(settle.settleEvent(event.id)).rejects.toThrow("falha de teste");
    expect(await scene.creditsOf(event.id)).toHaveLength(1);
    // no meio, o patrimônio de cada um é o mesmo de antes
    expect(await equity(after(REGISTERED, 31))).toEqual(before);
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([event.id]);

    // a tarefa da F12 continua de onde parou, sem pagar duas vezes
    ledger.failFrom = null;
    clock.set(after(REGISTERED, 40));
    const resumed = await settle.settlePending();
    expect(resumed.errors).toEqual([]);
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([]);
    // aprovar de novo não paga de novo
    expect((await approver.approve(scene.admin.id, { eventIds: [event.id] })).results[0]!.outcome).toBe("already_approved");
    expect((await settle.settleEvent(event.id)).credited).toBe(0);

    const credits = await scene.creditsOf(event.id);
    expect(credits.map((c) => [c.walletId, c.amount])).toEqual([
      [w.ana, 1_000 * BUYBACKS.FLA3],
      [w.bia, 200 * BUYBACKS.FLA3],
      [w.bot, 300 * BUYBACKS.FLA3],
    ]);
    expect(await scene.cashOf(w.ana)).toBe(cash.ana + 1_000 * BUYBACKS.FLA3);
    expect(await scene.cashOf(w.bia)).toBe(cash.bia + 200 * BUYBACKS.FLA3);
    expect(await scene.cashOf(w.bot)).toBe(cash.bot + 300 * BUYBACKS.FLA3);
    expect(await scene.cashOf(w.caio)).toBe(0);
    expect(await heldOf(s, "FLA3")).toBe(0);
    expect(await equity(after(REGISTERED, 50))).toEqual(before);
    const lines = await t.db
      .select()
      .from(payoutCredits)
      .innerJoin(wallets, eq(wallets.id, payoutCredits.walletId))
      .where(and(eq(payoutCredits.eventId, event.id), eq(wallets.ownerType, "treasury")));
    expect(lines).toEqual([]);
    const [treasuryFla] = await t.db.select().from(positions).where(and(eq(positions.walletId, s.treasury), eq(positions.clubId, scene.club("FLA3"))));
    expect(treasuryFla!.shares).toBe(0);
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });
});
