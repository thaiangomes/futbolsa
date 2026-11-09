import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { adminLog, payoutCredits, payoutEvents, payoutHoldings, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { ApproveService } from "../../src/modules/admin/payouts/approve.service.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, listClubs, openPlayerWallets, openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

const REPETITIONS = 50;
const TOTAL = 10_000;
const PER_SHARE = 10;
const CLOSE = new Date("2027-06-06T20:00:00Z");
const SHARES = [300, 200, 100];

describe("aprovação dos pagamentos ao mesmo tempo", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(new Date("2027-06-06T22:00:00Z"));
  let app: NestFastifyApplication;
  let approve: ApproveService;
  let settle: SettleCreditsService;
  let admins: [TestAccount, TestAccount];
  let seasonId: number;
  let clubId: number;
  let holders: number[];

  beforeAll(async () => {
    app = await createTestApp({ db: t.db, clock, override: (b) => withTestAuth(clock)(b) });
    approve = app.get(ApproveService, { strict: false });
    settle = app.get(SettleCreditsService, { strict: false });
    admins = [await createAccount(t.db, { role: "admin" }), await createAccount(t.db, { role: "admin" })];
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    clubId = seeded.clubIds.get("FLA3")!;
    await listClubs(t.db, seasonId, seeded.clubIds, ["FLA3"], TOTAL);
    const [treasury] = (await openWallets(t.db, seasonId, [{ type: "treasury" }])) as [number];
    holders = await openPlayerWallets(t.db, seasonId, SHARES.length);
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [...holders, treasury]);
      await post(tx, { walletId: treasury, at: CLOSE, kind: "adjustment", clubId, sharesDelta: TOTAL, price: 4000, costBasis: "purchase", reason: "emissão" });
      for (const [i, walletId] of holders.entries()) {
        const shares = SHARES[i]!;
        await post(tx, { walletId: treasury, at: CLOSE, kind: "trade", clubId, sharesDelta: -shares, cashDelta: shares * 100, price: 100, costBasis: "sale" });
        await post(tx, { walletId, at: CLOSE, kind: "trade", clubId, sharesDelta: shares, cashDelta: -shares * 100, price: 100, costBasis: "purchase" });
      }
    });
  });
  afterAll(async () => {
    await settle?.whenIdle();
    await app?.close();
  });

  async function pendingEvent(round: number): Promise<number> {
    const [row] = await t.db
      .insert(payoutEvents)
      .values({
        seasonId,
        clubId,
        eventKey: `points|brasileirao-a|${round}|FLA3`,
        kind: "points",
        reason: `1 ponto, rodada ${round}`,
        competition: "brasileirao-a",
        round,
        perShare: PER_SHARE,
        closedAt: CLOSE,
        createdAt: CLOSE,
      })
      .returning({ id: payoutEvents.id });
    await t.db.insert(payoutHoldings).values(holders.map((walletId, i) => ({ eventId: row!.id, walletId, shares: SHARES[i]! })));
    return row!.id;
  }

  it(`duas aprovações do mesmo evento ao mesmo tempo pagam uma vez, e duas liquidações em paralelo não duplicam crédito (${REPETITIONS} vezes)`, async () => {
    for (let round = 1; round <= REPETITIONS; round++) {
      const id = await pendingEvent(round);
      const responses = await Promise.all(admins.map((a) => approve.approve(a.id, { eventIds: [id] })));
      const outcomes = responses.map((r) => r.results[0]!.outcome).sort();
      expect(outcomes, `rodada ${round}`).toEqual(["already_approved", "approved"]);

      // as duas liquidações disputam as mesmas carteiras; cada lote tem a sua transação
      settle.batchSize = 2;
      await Promise.all([settle.settleEvent(id), settle.settleEvent(id)]);

      const credits = await t.db.select().from(payoutCredits).where(eq(payoutCredits.eventId, id));
      expect(credits, `rodada ${round}`).toHaveLength(holders.length);
      const entries = await t.db
        .select()
        .from(walletEntries)
        .where(and(eq(walletEntries.kind, "dividend"), eq(walletEntries.refId, String(id))));
      expect(entries, `rodada ${round}`).toHaveLength(holders.length);
      const logs = await t.db.select().from(adminLog).where(and(eq(adminLog.action, "payout.approve"), eq(adminLog.targetId, String(id))));
      expect(logs, `rodada ${round}`).toHaveLength(1);
    }

    // cada carteira recebeu exatamente uma vez por evento
    const rows = await t.db.select({ id: wallets.id, cash: wallets.cash }).from(wallets);
    for (const [i, walletId] of holders.entries()) {
      const cash = rows.find((r) => r.id === walletId)!.cash;
      expect(cash).toBe(INITIAL_CASH - SHARES[i]! * 100 + REPETITIONS * SHARES[i]! * PER_SHARE);
    }
    await assertLedgerConsistent(t.db, seasonId);
    await assertSharesConserved(t.db, seasonId);
  });

  it("a aprovação e a liquidação pela tarefa ao mesmo tempo: a tarefa só paga o que já está aprovado, uma vez", async () => {
    settle.batchSize = 2;
    const ids = await Promise.all([REPETITIONS + 1, REPETITIONS + 2, REPETITIONS + 3].map(pendingEvent));
    await Promise.all([
      ...ids.map((id) => approve.approve(admins[0].id, { eventIds: [id] })),
      settle.settlePending(),
      settle.settlePending(),
    ]);
    await settle.settlePending();
    await settle.whenIdle();
    for (const id of ids) {
      expect(await t.db.select().from(payoutCredits).where(eq(payoutCredits.eventId, id))).toHaveLength(holders.length);
    }
    await assertLedgerConsistent(t.db, seasonId);
  });
});
