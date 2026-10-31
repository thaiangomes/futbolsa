import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { lockWallets } from "../../src/infra/db/locks.js";
import { walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { LedgerError, post, type Movement } from "../../src/modules/portfolio/ledger/index.js";
import { assertLedgerConsistent } from "../support/invariants.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, listClubs, openPlayerWallets, openWallets, seedSeason, T0 } from "../support/fixtures.js";

describe("T7: portfolio.post, saldos, reservas e extrato", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let fla: number;

  beforeAll(async () => {
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    fla = seeded.clubIds.get("FLA3")!;
    await listClubs(t.db, seasonId, seeded.clubIds, ["FLA3"]);
  });

  /** Trava a carteira e aplica os movimentos numa transação. */
  const apply = (walletId: number, ...movements: Omit<Movement, "walletId" | "at">[]) =>
    withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [walletId]);
      let last;
      for (const m of movements) last = await post(tx, { walletId, at: T0, ...m });
      return last!;
    });

  const refused = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof LedgerError) return error.code;
      throw error;
    }
    throw new Error("era para o post recusar");
  };

  const walletOf = async (id: number) => (await t.db.select().from(wallets).where(eq(wallets.id, id)))[0]!;
  const entriesOf = (id: number) =>
    t.db.select().from(walletEntries).where(eq(walletEntries.walletId, id)).orderBy(asc(walletEntries.id));

  it("openWallet com R$ 100.000,00 deixa o caixa e uma linha initial com o caixa depois igual", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    expect(await walletOf(w!)).toMatchObject({ cash: INITIAL_CASH, reservedCash: 0, openOrders: 0, entryMode: "ipo" });
    const entries = await entriesOf(w!);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "initial", cashDelta: INITIAL_CASH, cashAfter: INITIAL_CASH });
  });

  it("reserva de compra de R$ 4.450,00 muda só o reservado; a liberação devolve", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    const reserved = await apply(w!, { kind: "order_reserve", reservedCashDelta: 445_000, openOrdersDelta: 1, ref: { type: "order", id: 1 } });
    expect(reserved.wallet).toMatchObject({ cash: INITIAL_CASH, reservedCash: 445_000, openOrders: 1 });
    expect(reserved.entry).toMatchObject({ kind: "order_reserve", cashAfter: INITIAL_CASH, refType: "order", refId: "1" });
    const released = await apply(w!, { kind: "order_release", reservedCashDelta: -445_000, openOrdersDelta: -1 });
    expect(released.wallet).toMatchObject({ cash: INITIAL_CASH, reservedCash: 0, openOrders: 0 });
  });

  it("negócio de compra consome a reserva e credita as ações; a venda consome as reservadas e credita o caixa", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    await apply(w!, { kind: "order_reserve", reservedCashDelta: 445_000, openOrdersDelta: 1 });
    // leva 50 a R$ 44,30 (R$ 2.215,00), as 50 restantes continuam reservadas a R$ 44,50
    const bought = await apply(w!, {
      kind: "trade",
      clubId: fla,
      cashDelta: -221_500,
      reservedCashDelta: -222_500,
      sharesDelta: 50,
      price: 4430,
      costBasis: "purchase",
    });
    expect(bought.wallet).toMatchObject({ cash: INITIAL_CASH - 221_500, reservedCash: 222_500 });
    expect(bought.position).toMatchObject({ shares: 50, reservedShares: 0 });
    await apply(w!, { kind: "order_reserve", clubId: fla, reservedSharesDelta: 20, openOrdersDelta: 1 });
    const sold = await apply(w!, {
      kind: "trade",
      clubId: fla,
      cashDelta: 20 * 4600,
      sharesDelta: -20,
      reservedSharesDelta: -20,
      price: 4600,
      costBasis: "sale",
      openOrdersDelta: -1,
    });
    expect(sold.position).toMatchObject({ shares: 30, reservedShares: 0 });
    expect(sold.wallet.cash).toBe(INITIAL_CASH - 221_500 + 92_000);
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("carteira 6: dividendo de R$ 360,00 soma no caixa e nos dividendos do clube", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    const paid = await apply(w!, { kind: "dividend", clubId: fla, cashDelta: 36_000, price: 30, ref: { type: "payout_event", id: 7 } });
    expect(paid.wallet.cash).toBe(INITIAL_CASH + 36_000);
    expect(paid.position!.dividends).toBe(36_000);
    expect(paid.entry.cashAfter).toBe(INITIAL_CASH + 36_000);
  });

  it("admin 15: estorno maior que o caixa deixa o caixa negativo só sem reserva; um dividendo abate o negativo", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1, 10_000);
    await apply(w!, { kind: "order_reserve", reservedCashDelta: 5_000, openOrdersDelta: 1 });
    // com compra aberta, o estorno é recusado: as compras são canceladas antes
    expect(await refused(apply(w!, { kind: "reversal", clubId: fla, cashDelta: -30_000, reason: "placar corrigido" }))).toBe(
      "reserved_exceeds_cash",
    );
    const reversed = await apply(
      w!,
      { kind: "order_release", reservedCashDelta: -5_000, openOrdersDelta: -1 },
      { kind: "reversal", clubId: fla, cashDelta: -30_000, reason: "placar corrigido" },
    );
    expect(reversed.wallet.cash).toBe(-20_000);
    expect(reversed.position!.dividends).toBe(-30_000);
    // com o caixa negativo, nada que tire caixa passa
    expect(await refused(apply(w!, { kind: "adjustment", cashDelta: -1, reason: "teste" }))).toBe("negative_cash");
    expect(await refused(apply(w!, { kind: "order_reserve", reservedCashDelta: 100 }))).toBe("reserved_exceeds_cash");
    const paid = await apply(w!, { kind: "dividend", clubId: fla, cashDelta: 5_000 });
    expect(paid.wallet.cash).toBe(-15_000);
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("um negócio ou ajuste que deixaria o caixa negativo é recusado", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1, 1_000);
    expect(
      await refused(apply(w!, { kind: "trade", clubId: fla, cashDelta: -1_001, sharesDelta: 1, price: 1_001, costBasis: "purchase" })),
    ).toBe("negative_cash");
    expect(await refused(apply(w!, { kind: "adjustment", cashDelta: -1_001, reason: "débito" }))).toBe("negative_cash");
  });

  it("recusa cada movimento inválido com o código", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1, 10_000);
    expect(await refused(apply(w!, { kind: "adjustment", cashDelta: 10.5, reason: "x" }))).toBe("invalid_cents");
    expect(await refused(apply(w!, { kind: "trade", clubId: fla, sharesDelta: 1.5, price: 100, costBasis: "purchase" }))).toBe(
      "invalid_quantity",
    );
    expect(await refused(apply(w!, { kind: "order_reserve", reservedCashDelta: 20_000 }))).toBe("reserved_exceeds_cash");
    expect(await refused(apply(w!, { kind: "order_release", reservedCashDelta: -1 }))).toBe("negative_reserved_cash");
    expect(await refused(apply(w!, { kind: "trade", sharesDelta: 1, price: 100, costBasis: "purchase" }))).toBe("club_required");
    expect(await refused(apply(w!, { kind: "dividend", cashDelta: 100 }))).toBe("club_required");
    expect(await refused(apply(w!, { kind: "trade", clubId: fla, sharesDelta: 1, price: 100 }))).toBe("cost_basis_required");
    expect(await refused(apply(w!, { kind: "trade", clubId: fla, sharesDelta: 1, costBasis: "purchase" }))).toBe("price_required");
    expect(await refused(apply(w!, { kind: "trade", clubId: fla, sharesDelta: -1, price: 100, costBasis: "sale" }))).toBe(
      "negative_shares",
    );
    expect(await refused(apply(w!, { kind: "order_reserve", clubId: fla, reservedSharesDelta: 1 }))).toBe(
      "reserved_exceeds_shares",
    );
    expect(await refused(apply(w!, { kind: "order_release", clubId: fla, reservedSharesDelta: -1 }))).toBe(
      "negative_reserved_shares",
    );
    expect(await refused(apply(w!, { kind: "order_release", openOrdersDelta: -1 }))).toBe("negative_open_orders");
    for (const kind of ["adjustment", "reversal", "complement"] as const) {
      expect(await refused(apply(w!, { kind, clubId: fla, cashDelta: 1, reason: "  " })), kind).toBe("reason_required");
    }
    // nada do que foi recusado ficou gravado
    expect(await entriesOf(w!)).toHaveLength(1);
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("post numa carteira não travada é recusado, mesmo dentro de uma transação", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    const code = await refused(
      withTransaction(t.db, (tx) => post(tx, { walletId: w!, at: T0, kind: "adjustment", cashDelta: 1, reason: "x" })),
    );
    expect(code).toBe("wallet_not_locked");
  });

  it("o cash_after de cada linha é o caixa depois dela, numa sequência de movimentos", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1, 50_000);
    await apply(
      w!,
      { kind: "adjustment", cashDelta: 1_000, reason: "crédito" },
      { kind: "dividend", clubId: fla, cashDelta: 250 },
      { kind: "adjustment", cashDelta: -20_000, reason: "débito" },
    );
    expect((await entriesOf(w!)).map((e) => e.cashAfter)).toEqual([50_000, 51_000, 51_250, 31_250]);
  });

  it("um erro depois do post na mesma transação desfaz o movimento e a linha do extrato", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1, 50_000);
    await expect(
      withTransaction(t.db, async (tx) => {
        await lockWallets(tx, [w!]);
        await post(tx, { walletId: w!, at: T0, kind: "adjustment", cashDelta: 9_999, reason: "x" });
        throw new Error("falhou depois");
      }),
    ).rejects.toThrow("falhou depois");
    expect((await walletOf(w!)).cash).toBe(50_000);
    expect(await entriesOf(w!)).toHaveLength(1);
  });

  it("a tesouraria abre sem caixa e recebe ações", async () => {
    const [treasury] = await openWallets(t.db, seasonId, [{ type: "treasury" }]);
    const received = await apply(treasury!, {
      kind: "ipo_settle",
      clubId: fla,
      sharesDelta: 300,
      price: 3500,
      costBasis: "purchase",
      reason: "lote do formador",
    });
    expect(received.wallet.cash).toBe(0);
    expect(received.position!.shares).toBe(300);
  });
});
