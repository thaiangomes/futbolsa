import { asc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { lockClubs, lockWallets } from "../../src/infra/db/locks.js";
import { walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { LedgerError, post } from "../../src/modules/portfolio/ledger/index.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openPlayerWallets, openWallets, rng, seedSeason, T0 } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved, totalCash } from "../support/invariants.js";

const TICKERS = ["BOT3", "FLA3", "PAL3"];

describe("T9: carteiras sob concorrência, contra o Postgres", () => {
  const t = useTestDatabase(30);
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let players: number[];

  beforeAll(async () => {
    ({ seasonId, clubIds } = await seedSeason(t.db));
    await listClubs(t.db, seasonId, clubIds, TICKERS, 3_000);
    treasury = (await openWallets(t.db, seasonId, [{ type: "treasury" }]))[0]!;
    players = await openPlayerWallets(t.db, seasonId, 20, 1_000_000);
    // a tesouraria recebe as 3.000 ações de cada clube e um caixa para comprar
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [treasury]);
      await post(tx, { walletId: treasury, at: T0, kind: "adjustment", cashDelta: 5_000_000, reason: "caixa inicial do teste" });
      for (const ticker of TICKERS) {
        await post(tx, {
          walletId: treasury,
          at: T0,
          kind: "ipo_settle",
          clubId: clubIds.get(ticker)!,
          sharesDelta: 3_000,
          price: 1_000,
          costBasis: "purchase",
        });
      }
    });
  });

  it("100 transações ao mesmo tempo na mesma carteira: caixa exato e cash_after sem buraco", async () => {
    const target = players[0]!;
    const before = (await t.db.select().from(wallets).where(eq(wallets.id, target)))[0]!.cash;
    const deltas = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? -(i + 1) : i + 1));
    await Promise.all(
      deltas.map((delta) =>
        withTransaction(t.db, async (tx) => {
          await lockWallets(tx, [target]);
          await post(tx, { walletId: target, at: T0, kind: "adjustment", cashDelta: delta, reason: "teste" });
        }),
      ),
    );
    const after = (await t.db.select().from(wallets).where(eq(wallets.id, target)))[0]!.cash;
    expect(after).toBe(before + deltas.reduce((a, b) => a + b, 0));
    const entries = await t.db.select().from(walletEntries).where(eq(walletEntries.walletId, target)).orderBy(asc(walletEntries.id));
    expect(entries).toHaveLength(101);
    let running = 0;
    for (const e of entries) {
      running += e.cashDelta;
      expect(e.cashAfter).toBe(running);
    }
  });

  it("300 transferências sorteadas ao mesmo tempo, com a tesouraria às vezes: dinheiro conservado e nenhum deadlock", async () => {
    const random = rng(42);
    const cashBefore = await totalCash(t.db, seasonId);
    let retries = 0;
    let refused = 0;
    const jobs = Array.from({ length: 300 }, () => {
      const pick = () => players[Math.floor(random() * players.length)]!;
      const from = random() < 0.15 ? treasury : pick();
      let to = random() < 0.15 ? treasury : pick();
      if (to === from) to = from === treasury ? players[0]! : treasury;
      const amount = 1 + Math.floor(random() * 5_000);
      // as carteiras chegam na ordem que vier; lockWallets ordena
      const order = random() < 0.5 ? [from, to] : [to, from];
      return withTransaction(
        t.db,
        async (tx) => {
          await lockWallets(tx, order);
          await post(tx, { walletId: from, at: T0, kind: "adjustment", cashDelta: -amount, reason: "transferência" });
          await post(tx, { walletId: to, at: T0, kind: "adjustment", cashDelta: amount, reason: "transferência" });
        },
        { onRetry: () => retries++ },
      ).catch((error) => {
        if (error instanceof LedgerError) refused++;
        else throw error;
      });
    });
    await Promise.all(jobs);
    expect(retries).toBe(0);
    expect(refused).toBe(0);
    expect(await totalCash(t.db, seasonId)).toBe(cashBefore);
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("300 negócios sorteados entre carteiras e a tesouraria: ações e dinheiro conservados", async () => {
    const random = rng(7);
    const cashBefore = await totalCash(t.db, seasonId);
    let retries = 0;
    let refused = 0;
    const everyone = [treasury, ...players];
    const jobs = Array.from({ length: 300 }, () => {
      const ticker = TICKERS[Math.floor(random() * TICKERS.length)]!;
      const seller = everyone[Math.floor(random() * everyone.length)]!;
      let buyer = everyone[Math.floor(random() * everyone.length)]!;
      if (buyer === seller) buyer = seller === treasury ? players[1]! : treasury;
      const quantity = 1 + Math.floor(random() * 40);
      const price = 800 + Math.floor(random() * 400);
      const clubId = clubIds.get(ticker)!;
      return withTransaction(
        t.db,
        async (tx) => {
          // clube antes das carteiras, como o motor de ordens
          await lockClubs(tx, seasonId, [ticker]);
          await lockWallets(tx, [buyer, seller]);
          await post(tx, {
            walletId: seller,
            at: T0,
            kind: "trade",
            clubId,
            sharesDelta: -quantity,
            cashDelta: quantity * price,
            price,
            costBasis: "sale",
          });
          await post(tx, {
            walletId: buyer,
            at: T0,
            kind: "trade",
            clubId,
            sharesDelta: quantity,
            cashDelta: -quantity * price,
            price,
            costBasis: "purchase",
          });
          await tx.db.execute(sql`select 1`);
        },
        { onRetry: () => retries++ },
      ).catch((error) => {
        if (error instanceof LedgerError) refused++;
        else throw error;
      });
    });
    await Promise.all(jobs);
    expect(retries).toBe(0);
    // vendedor sem ações é recusado sem deixar nada pela metade
    expect(refused).toBeGreaterThan(0);
    expect(await totalCash(t.db, seasonId)).toBe(cashBefore);
    await assertSharesConserved(t.db, seasonId);
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("os verificadores pegam um estado errado gravado à mão", async () => {
    await t.db.update(wallets).set({ cash: sql`${wallets.cash} + 1` }).where(eq(wallets.id, players[5]!));
    await expect(assertLedgerConsistent(t.db, seasonId)).rejects.toThrow(/carteira diferente da soma do extrato/);
    await t.db.update(wallets).set({ cash: sql`${wallets.cash} - 1` }).where(eq(wallets.id, players[5]!));
    await t.db.execute(sql`update futbolsa.season_clubs set total_shares = total_shares + 1 where season_id = ${seasonId}`);
    await expect(assertSharesConserved(t.db, seasonId)).rejects.toThrow(/ações do clube diferentes do total emitido/);
  });
});
