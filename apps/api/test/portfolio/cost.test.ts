import { averagePrice } from "@futbolsa/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { lockWallets } from "../../src/infra/db/locks.js";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { LedgerError, post, type Movement, type PostResult } from "../../src/modules/portfolio/ledger/index.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openPlayerWallets, seedSeason, T0 } from "../support/fixtures.js";
import { assertLedgerConsistent } from "../support/invariants.js";

/** Reais para centavos, para os números ficarem como na especificação. */
const R = (reais: number) => Math.round(reais * 100);

describe("T8: custo, preço médio e resultado realizado (Carteira e gráficos)", () => {
  const t = useTestDatabase(4);
  let seasonId: number;
  let fla: number;

  beforeAll(async () => {
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    fla = seeded.clubIds.get("FLA3")!;
    await listClubs(t.db, seasonId, seeded.clubIds, ["FLA3"]);
  });

  const apply = (walletId: number, m: Omit<Movement, "walletId" | "at" | "clubId">): Promise<PostResult> =>
    withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [walletId]);
      return post(tx, { walletId, at: T0, clubId: fla, ...m });
    });
  const ipo = (w: number, quantity: number, price: number) =>
    apply(w, { kind: "ipo_settle", sharesDelta: quantity, cashDelta: -quantity * price, price, costBasis: "purchase" });
  const buyTrade = (w: number, quantity: number, price: number) =>
    apply(w, { kind: "trade", sharesDelta: quantity, cashDelta: -quantity * price, price, costBasis: "purchase" });
  const sellTrade = (w: number, quantity: number, price: number) =>
    apply(w, { kind: "trade", sharesDelta: -quantity, cashDelta: quantity * price, price, costBasis: "sale" });
  const average = (r: PostResult) => averagePrice({ ...r.position!, dividends: 0 });

  /** Ana com 1.200 FLA3 a preço médio R$ 37 (critérios 1 a 3). */
  async function anaWith1200() {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    await ipo(w!, 1_000, R(35));
    await buyTrade(w!, 500, R(41));
    await sellTrade(w!, 300, R(45));
    return w!;
  }

  it("carteira 1: IPO de 1.000 FLA3 a R$ 35 dá custo de R$ 35.000,00 e preço médio de R$ 35,00", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    const r = await ipo(w!, 1_000, R(35));
    expect(r.position).toMatchObject({ shares: 1_000, cost: R(35_000) });
    expect(average(r)).toBe(R(35));
  });

  it("carteira 2 e 3: compra de 500 a R$ 41 e venda de 300 a R$ 45 realizam R$ 2.400,00", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    await ipo(w!, 1_000, R(35));
    const bought = await buyTrade(w!, 500, R(41));
    expect(bought.position).toMatchObject({ shares: 1_500, cost: R(55_500) });
    expect(average(bought)).toBe(R(37));
    const sold = await sellTrade(w!, 300, R(45));
    expect(sold.position).toMatchObject({ shares: 1_200, cost: R(44_400), realized: R(2_400) });
    expect(sold.entry.realized).toBe(R(2_400));
    expect(average(sold)).toBe(R(37));
  });

  it("carteira 4: venda de 200 a R$ 30 com preço médio de R$ 37 realiza −R$ 1.400,00", async () => {
    const w = await anaWith1200();
    const sold = await sellTrade(w, 200, R(30));
    expect(sold.entry.realized).toBe(R(-1_400));
    expect(average(sold)).toBe(R(37));
  });

  it("carteira 5: zerar e comprar 100 a R$ 50 recomeça o preço médio em R$ 50,00", async () => {
    const w = await anaWith1200();
    const zeroed = await sellTrade(w, 1_200, R(44));
    expect(zeroed.position).toMatchObject({ shares: 0, cost: 0 });
    const again = await buyTrade(w, 100, R(50));
    expect(average(again)).toBe(R(50));
    expect(again.position!.cost).toBe(R(5_000));
  });

  it("carteira 6: dividendo de R$ 0,30 por ação em 1.200 ações não muda o custo", async () => {
    const w = await anaWith1200();
    const paid = await apply(w, { kind: "dividend", cashDelta: 1_200 * 30 });
    expect(paid.position).toMatchObject({ cost: R(44_400), dividends: R(360) });
    expect(average(paid)).toBe(R(37));
  });

  it("carteira 15: carteira índice com 150 FLA3 a R$ 44 dá preço médio de R$ 44,00", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    const r = await apply(w!, { kind: "index_entry", sharesDelta: 150, price: R(44), costBasis: "purchase" });
    expect(average(r)).toBe(R(44));
  });

  it("carteira 21: recompra de 1.200 a R$ 19,35 realiza −R$ 21.180,00 e zera a posição e o custo", async () => {
    const w = await anaWith1200();
    const bought = await apply(w, {
      kind: "buyback",
      sharesDelta: -1_200,
      cashDelta: 1_200 * R(19.35),
      price: R(19.35),
      costBasis: "sale",
    });
    expect(bought.entry).toMatchObject({ cashDelta: R(23_220), realized: R(-21_180) });
    expect(bought.position).toMatchObject({ shares: 0, cost: 0 });
  });

  it("carteira 39: crédito do admin pelo preço exibido e débito sem resultado realizado", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    await buyTrade(w!, 100, R(37));
    const credited = await apply(w!, {
      kind: "adjustment",
      sharesDelta: 100,
      price: R(44),
      costBasis: "purchase",
      reason: "crédito de ações pelo admin",
    });
    expect(credited.position).toMatchObject({ shares: 200, cost: R(8_100), realized: 0 });
    expect(average(credited)).toBe(R(40.5));
    const debited = await apply(w!, { kind: "adjustment", sharesDelta: -50, costBasis: "debit", reason: "débito de ações pelo admin" });
    expect(debited.position).toMatchObject({ shares: 150, cost: R(6_075), realized: 0 });
    expect(debited.entry.realized).toBeNull();
    expect(average(debited)).toBe(R(40.5));
  });

  it("arredondamento: venda de 1 de 3 ações com custo de R$ 10,00 tira R$ 3,33; a venda do resto leva o custo inteiro", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    await buyTrade(w!, 1, 334);
    await buyTrade(w!, 2, 333);
    const first = await sellTrade(w!, 1, 500);
    expect(first.position!.cost).toBe(667);
    expect(first.entry.realized).toBe(167);
    const rest = await sellTrade(w!, 2, 500);
    expect(rest.position).toMatchObject({ shares: 0, cost: 0, realized: 500 });
  });

  it("origem do custo trocada é recusada", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    await buyTrade(w!, 10, R(10));
    const refused = (m: Omit<Movement, "walletId" | "at" | "clubId">) =>
      apply(w!, m).then(
        () => undefined,
        (e: unknown) => (e instanceof LedgerError ? e.code : e),
      );
    expect(await refused({ kind: "trade", sharesDelta: 1, price: 100, costBasis: "sale" })).toBe("cost_basis_mismatch");
    expect(await refused({ kind: "trade", sharesDelta: -1, price: 100, costBasis: "purchase" })).toBe("cost_basis_mismatch");
  });

  it("o estado continua igual à soma do extrato", async () => {
    await assertLedgerConsistent(t.db, seasonId);
  });
});
