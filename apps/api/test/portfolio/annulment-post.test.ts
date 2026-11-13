import { replayCost, type ReplayEntry } from "@futbolsa/engine";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { lockWallets } from "../../src/infra/db/locks.js";
import { positions, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { TRADE_REF } from "../../src/modules/market/matching/settle.js";
import { ANNULLED_REF_TYPE } from "../../src/modules/portfolio/ledger/apply.js";
import { LedgerError, post, postMany, type Movement } from "../../src/modules/portfolio/ledger/index.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, listClubs, openPlayerWallets, openWallets, seedSeason, T0 } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

type Move = Omit<Movement, "walletId" | "at">;

/** Ações do FLA3 emitidas na temporada do teste, todas começando na tesouraria. */
const TOTAL_SHARES = 1_000_000;

/**
 * T19 do Plano do admin de jogadores e bots (critério 42, propostas 16 a 18): o `portfolio.post` aceita a linha
 * `trade_annulled`, que desfaz um negócio anulado por trapaça. O caixa pode ficar negativo e o custo e o resultado
 * da posição chegam prontos, refeitos por `replayCost`.
 */
describe("T19: portfolio.post com a linha trade_annulled", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let fla: number;
  let treasury: number;
  /** Ids de negócio únicos no arquivo (o `ref` da linha). */
  let nextTrade = 100;

  beforeAll(async () => {
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    fla = seeded.clubIds.get("FLA3")!;
    await listClubs(t.db, seasonId, seeded.clubIds, ["FLA3"], TOTAL_SHARES);
    treasury = (await openWallets(t.db, seasonId, [{ type: "treasury" }]))[0]!;
    await apply(treasury, { kind: "ipo_settle", clubId: fla, sharesDelta: TOTAL_SHARES, price: 3500, costBasis: "purchase", reason: "lote" });
  });

  /** Trava a carteira e aplica os movimentos com um laço de `post`, numa transação. */
  const apply = (walletId: number, ...movements: Move[]) =>
    withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [walletId]);
      let last;
      for (const m of movements) last = await post(tx, { walletId, at: T0, ...m });
      return last!;
    });

  /** Os mesmos movimentos com um `postMany` só. */
  const applyMany = (walletId: number, movements: Move[]) =>
    withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [walletId]);
      return postMany(tx, movements.map((m) => ({ walletId, at: T0, ...m })));
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
  const positionOf = async (walletId: number) =>
    (await t.db.select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, fla))))[0];
  const entriesOf = (id: number) =>
    t.db.select().from(walletEntries).where(eq(walletEntries.walletId, id)).orderBy(asc(walletEntries.id));

  /** As duas linhas `trade` de um negócio do FLA3, gravadas cada uma na sua carteira. */
  async function trade(buyer: number, seller: number, quantity: number, price: number): Promise<number> {
    const id = nextTrade++;
    const ref = { type: TRADE_REF, id };
    await apply(seller, { kind: "trade", clubId: fla, sharesDelta: -quantity, cashDelta: quantity * price, price, costBasis: "sale", ref });
    await apply(buyer, { kind: "trade", clubId: fla, sharesDelta: quantity, cashDelta: -quantity * price, price, costBasis: "purchase", ref });
    return id;
  }

  /** A linha `trade_annulled` de um lado do negócio, com o custo e o resultado que `replayCost` deu. */
  const annul = (
    tradeId: number,
    side: { sharesDelta: number; cashDelta: number; price: number },
    history: ReplayEntry[],
    remaining: Map<number, number>,
  ): Move => {
    const replayed = replayCost(history, remaining);
    return {
      kind: "trade_annulled",
      clubId: fla,
      ...side,
      annulled: { cost: replayed.cost, realized: replayed.realized },
      ref: { type: ANNULLED_REF_TYPE, id: tradeId },
      reason: "trapaça entre contas",
    };
  };

  /**
   * O vendedor compra 100 da tesouraria a R$ 40,00 e vende as 100 ao comprador a R$ 60,00 (resultado de
   * R$ 2.000,00); depois gasta o caixa num débito do admin, até ficar com R$ 2.000,00. Anular a venda tira
   * R$ 6.000,00 dele: o caixa fica em −R$ 4.000,00.
   */
  async function cheatingPair(sellerCash = INITIAL_CASH) {
    const [seller, buyer] = (await openPlayerWallets(t.db, seasonId, 2, sellerCash)) as [number, number];
    const bought = await trade(seller, treasury, 100, 4000);
    await apply(seller, { kind: "dividend", clubId: fla, cashDelta: 1_000 });
    const sold = await trade(buyer, seller, 100, 6000);
    await apply(seller, { kind: "adjustment", cashDelta: -(sellerCash - 400_000 + 600_000 + 1_000 - 200_000), reason: "gastou o caixa" });
    const remaining = new Map([[sold, 0]]);
    const sellerLine = annul(
      sold,
      { sharesDelta: 100, cashDelta: -600_000, price: 6000 },
      [
        { sharesDelta: 100, price: 4000, tradeId: bought },
        { sharesDelta: -100, price: 6000, tradeId: sold },
      ],
      remaining,
    );
    const buyerLine = annul(sold, { sharesDelta: -100, cashDelta: 600_000, price: 6000 }, [{ sharesDelta: 100, price: 6000, tradeId: sold }], remaining);
    return { seller, buyer, sold, sellerLine, buyerLine };
  }

  it("admin 42: a linha trade_annulled devolve as ações e o dinheiro e deixa o caixa negativo, com custo e resultado prontos", async () => {
    const { seller, buyer, sold, sellerLine, buyerLine } = await cheatingPair();
    expect((await walletOf(seller)).cash).toBe(200_000);
    expect(await positionOf(seller)).toMatchObject({ shares: 0, cost: 0, realized: 200_000, dividends: 1_000 });

    const s = await apply(seller, sellerLine);
    expect(s.wallet).toMatchObject({ cash: -400_000, reservedCash: 0 });
    // como se a venda não tivesse existido: as 100 de volta pelo custo de R$ 40,00 e o resultado de volta a zero
    expect(s.position).toMatchObject({ shares: 100, reservedShares: 0, cost: 400_000, realized: 0, dividends: 1_000 });
    expect(s.entry).toMatchObject({
      kind: "trade_annulled",
      clubId: fla,
      cashDelta: -600_000,
      sharesDelta: 100,
      price: 6000,
      realized: -200_000,
      cashAfter: -400_000,
      refType: "trade",
      refId: String(sold),
      reason: "trapaça entre contas",
    });

    const b = await apply(buyer, buyerLine);
    expect(b.wallet.cash).toBe(INITIAL_CASH);
    expect(b.position).toMatchObject({ shares: 0, cost: 0, realized: 0, dividends: 0 });
    // sem mudança no resultado, a linha não tem resultado realizado
    expect(b.entry).toMatchObject({ kind: "trade_annulled", sharesDelta: -100, cashDelta: 600_000, realized: null, cashAfter: INITIAL_CASH });

    await assertLedgerConsistent(t.db, seasonId);
    await assertSharesConserved(t.db, seasonId);
  });

  it("admin 42: o custo e o resultado gravados são os do movimento, não os da conta de compra e venda", async () => {
    // o comprador comprou 30 a R$ 50,00 da tesouraria e 20 a R$ 80,00 do vendedor, e vendeu 10 a R$ 90,00 de volta à
    // tesouraria; anulado o negócio de R$ 80,00, sobram as 30 compradas a R$ 50,00, menos as 10 vendidas a R$ 90,00
    const [seller, buyer] = (await openPlayerWallets(t.db, seasonId, 2)) as [number, number];
    const first = await trade(buyer, treasury, 30, 5000);
    const sellerBuy = await trade(seller, treasury, 20, 4000);
    const cheat = await trade(buyer, seller, 20, 8000);
    const sale = await trade(treasury, buyer, 10, 9000);
    const remaining = new Map([[cheat, 0]]);
    const history: ReplayEntry[] = [
      { sharesDelta: 30, price: 5000, tradeId: first },
      { sharesDelta: 20, price: 8000, tradeId: cheat },
      { sharesDelta: -10, price: 9000, tradeId: sale },
    ];
    const expected = replayCost(history, remaining);
    expect(expected).toEqual({ shares: 20, cost: 100_000, realized: 40_000 });
    const before = (await positionOf(buyer))!;
    // pela conta de venda na proporção, o custo seria outro (preço médio de R$ 62,00, não R$ 50,00)
    expect(before).toMatchObject({ shares: 40, cost: 248_000, realized: 28_000 });

    const r = await apply(buyer, annul(cheat, { sharesDelta: -20, cashDelta: 160_000, price: 8000 }, history, remaining));
    expect(r.position).toMatchObject({ shares: 20, cost: expected.cost, realized: expected.realized, dividends: before.dividends });
    expect(r.entry.realized).toBe(expected.realized - before.realized);
    // o vendedor recebe as 20 de volta pelo custo de R$ 40,00, sem o resultado da venda
    const s = await apply(
      seller,
      annul(
        cheat,
        { sharesDelta: 20, cashDelta: -160_000, price: 8000 },
        [
          { sharesDelta: 20, price: 4000, tradeId: sellerBuy },
          { sharesDelta: -20, price: 8000, tradeId: cheat },
        ],
        remaining,
      ),
    );
    expect(s.position).toMatchObject({ shares: 20, cost: 80_000, realized: 0 });
    expect(s.entry.realized).toBe(-80_000);
    await assertLedgerConsistent(t.db, seasonId);
    await assertSharesConserved(t.db, seasonId);
  });

  it("admin 42: sem ações livres para devolver (a falta toda), a linha é gravada sem mexer nas ações nem no caixa", async () => {
    const [seller, buyer] = (await openPlayerWallets(t.db, seasonId, 2)) as [number, number];
    await trade(seller, treasury, 10, 4000);
    const cheat = await trade(buyer, seller, 10, 7000);
    await trade(treasury, buyer, 10, 7000);
    const before = (await positionOf(buyer))!;
    const history: ReplayEntry[] = [
      { sharesDelta: 10, price: 7000, tradeId: cheat },
      { sharesDelta: -10, price: 7000 },
    ];
    const r = await apply(buyer, annul(cheat, { sharesDelta: 0, cashDelta: 0, price: 7000 }, history, new Map([[cheat, 10]])));
    expect(r.position).toMatchObject({ shares: 0, cost: before.cost, realized: before.realized });
    expect(r.entry).toMatchObject({ kind: "trade_annulled", sharesDelta: 0, cashDelta: 0, realized: null, refId: String(cheat) });
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("admin 42: com compra aberta, a linha trade_annulled que deixaria o caixa negativo é recusada", async () => {
    const { seller, buyer, sellerLine, buyerLine } = await cheatingPair();
    await apply(buyer, buyerLine);
    await apply(seller, { kind: "order_reserve", reservedCashDelta: 1_000, openOrdersDelta: 1 });
    expect(await refused(apply(seller, sellerLine))).toBe("reserved_exceeds_cash");
    // canceladas as compras antes, como a T25 faz, passa
    const r = await apply(seller, { kind: "order_release", reservedCashDelta: -1_000, openOrdersDelta: -1 }, sellerLine);
    expect(r.wallet.cash).toBe(-400_000);
  });

  it("admin 42: os outros tipos continuam recusando o caixa negativo; entradas abatem o negativo", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1, 1_000);
    expect(
      await refused(apply(w!, { kind: "trade", clubId: fla, cashDelta: -1_001, sharesDelta: 1, price: 1_001, costBasis: "purchase" })),
    ).toBe("negative_cash");
    expect(await refused(apply(w!, { kind: "adjustment", cashDelta: -1_001, reason: "débito" }))).toBe("negative_cash");
    expect(await refused(apply(w!, { kind: "buyback", clubId: fla, cashDelta: -1_001 }))).toBe("negative_cash");

    const { seller, buyer, sellerLine, buyerLine } = await cheatingPair();
    await apply(buyer, buyerLine);
    await apply(seller, sellerLine);
    // com o caixa negativo, nada que tire caixa passa, menos outra anulação
    expect(await refused(apply(seller, { kind: "adjustment", cashDelta: -1, reason: "teste" }))).toBe("negative_cash");
    expect(
      await refused(apply(seller, { kind: "trade", clubId: fla, cashDelta: -4000, sharesDelta: 1, price: 4000, costBasis: "purchase" })),
    ).toBe("negative_cash");
    expect(await refused(apply(seller, { kind: "order_reserve", reservedCashDelta: 100 }))).toBe("reserved_exceeds_cash");
    // uma venda (à tesouraria) abate o negativo
    await trade(treasury, seller, 10, 4000);
    expect((await walletOf(seller)).cash).toBe(-360_000);
    // outra anulação ainda pode tirar caixa (a falta toda: só o dinheiro de um negócio sem ações de volta)
    const again = await apply(seller, {
      ...sellerLine,
      sharesDelta: 0,
      cashDelta: -1_000,
      annulled: { cost: 360_000, realized: 0 },
      ref: { type: ANNULLED_REF_TYPE, id: 9_999 },
    });
    expect(again.wallet.cash).toBe(-361_000);
    expect(again.position).toMatchObject({ shares: 90, cost: 360_000, realized: 0 });
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("admin 42: trade_annulled pede motivo, o negócio no ref e o custo pronto; os outros tipos não aceitam o custo pronto", async () => {
    // o ref da linha é o do negócio, o mesmo do mercado
    expect(ANNULLED_REF_TYPE).toBe(TRADE_REF);
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    await trade(w!, treasury, 10, 4000);
    const ok: Move = {
      kind: "trade_annulled",
      clubId: fla,
      sharesDelta: -10,
      cashDelta: 40_000,
      price: 4000,
      annulled: { cost: 0, realized: 0 },
      ref: { type: ANNULLED_REF_TYPE, id: 1 },
      reason: "trapaça",
    };
    const before = await entriesOf(w!);
    expect(await refused(apply(w!, { ...ok, reason: undefined }))).toBe("reason_required");
    expect(await refused(apply(w!, { ...ok, reason: "   " }))).toBe("reason_required");
    expect(await refused(apply(w!, { ...ok, ref: undefined }))).toBe("trade_ref_required");
    expect(await refused(apply(w!, { ...ok, ref: { type: "order", id: 1 } }))).toBe("trade_ref_required");
    expect(await refused(apply(w!, { ...ok, ref: { type: ANNULLED_REF_TYPE, id: " " } }))).toBe("trade_ref_required");
    expect(await refused(apply(w!, { ...ok, annulled: undefined }))).toBe("annulled_required");
    expect(await refused(apply(w!, { ...ok, clubId: undefined }))).toBe("club_required");
    expect(await refused(apply(w!, { ...ok, sharesDelta: 0, cashDelta: 0, clubId: undefined }))).toBe("club_required");
    expect(await refused(apply(w!, { ...ok, costBasis: "sale" }))).toBe("cost_basis_mismatch");
    expect(await refused(apply(w!, { ...ok, annulled: { cost: 0.5, realized: 0 } }))).toBe("invalid_cents");
    expect(await refused(apply(w!, { ...ok, annulled: { cost: 0, realized: 1.5 } }))).toBe("invalid_cents");
    expect(await refused(apply(w!, { ...ok, annulled: { cost: -1, realized: 0 } }))).toBe("invalid_cents");
    expect(await refused(apply(w!, { ...ok, sharesDelta: -11 }))).toBe("negative_shares");
    // o custo pronto só vale na anulação
    expect(
      await refused(apply(w!, { kind: "trade", clubId: fla, sharesDelta: -1, cashDelta: 4000, price: 4000, costBasis: "sale", annulled: { cost: 0, realized: 0 } })),
    ).toBe("annulled_not_allowed");
    expect(await refused(apply(w!, { kind: "adjustment", cashDelta: 1, reason: "x", annulled: { cost: 0, realized: 0 } }))).toBe(
      "annulled_not_allowed",
    );
    // nada do que foi recusado ficou gravado
    expect(await entriesOf(w!)).toEqual(before);
    expect((await apply(w!, ok)).position).toMatchObject({ shares: 0, cost: 0, realized: 0 });
    // a tesouraria recebe as 10 de volta (o custo dela aqui não importa: só fecha a conta das ações)
    const vault = (await positionOf(treasury))!;
    await apply(treasury, { ...ok, sharesDelta: 10, cashDelta: -40_000, annulled: { cost: vault.cost, realized: vault.realized } });
    await assertLedgerConsistent(t.db, seasonId);
    await assertSharesConserved(t.db, seasonId);
  });

  it("admin 42: postMany grava o mesmo que o laço de post, inclusive com o caixa negativo, e recusa o mesmo", async () => {
    const viaLoop = await cheatingPair();
    const viaMany = await cheatingPair();
    const sellerMoves = (p: typeof viaLoop): Move[] => [
      { kind: "dividend", clubId: fla, cashDelta: 500 },
      p.sellerLine,
      { kind: "dividend", clubId: fla, cashDelta: 300 },
    ];
    const loop = await apply(viaLoop.seller, ...sellerMoves(viaLoop));
    const many = await applyMany(viaMany.seller, sellerMoves(viaMany));
    await apply(viaLoop.buyer, viaLoop.buyerLine);
    await applyMany(viaMany.buyer, [viaMany.buyerLine]);

    const strip = async (walletId: number) => {
      const { id: _id, userId: _u, ...wallet } = await walletOf(walletId);
      const { walletId: _w, ...position } = (await positionOf(walletId))!;
      const entries = (await entriesOf(walletId)).map(({ id: _i, walletId: _ew, refId: _r, ...e }) => e);
      return { wallet, position, entries };
    };
    expect(await strip(viaMany.seller)).toEqual(await strip(viaLoop.seller));
    expect(await strip(viaMany.buyer)).toEqual(await strip(viaLoop.buyer));
    expect(many.wallet!.cash).toBe(loop.wallet.cash);
    expect(many.results[1]!.entry).toMatchObject({ kind: "trade_annulled", realized: -200_000, cashAfter: -399_500 });
    expect(many.positions.get(fla)).toMatchObject({ shares: 100, cost: 400_000, realized: 0, dividends: 1_800 });

    // as mesmas recusas: sem o custo pronto, e o débito depois da anulação
    const refusedPair = await cheatingPair();
    expect(await refused(applyMany(refusedPair.seller, [{ ...refusedPair.sellerLine, annulled: undefined }]))).toBe("annulled_required");
    expect(await refused(applyMany(refusedPair.seller, [refusedPair.sellerLine, { kind: "adjustment", cashDelta: -1, reason: "x" }]))).toBe(
      "negative_cash",
    );
    expect((await walletOf(refusedPair.seller)).cash).toBe(200_000);
    await assertLedgerConsistent(t.db, seasonId);
    await assertSharesConserved(t.db, seasonId);
  });
});
