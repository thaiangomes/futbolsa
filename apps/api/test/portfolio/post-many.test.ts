import { CLUBS } from "@futbolsa/engine";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/infra/db/client.js";
import { lockWallets } from "../../src/infra/db/locks.js";
import { clubs as clubTable, positions, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { LedgerError, post, postMany, type Movement, type PostResult } from "../../src/modules/portfolio/ledger/index.js";
import { countingDatabase, countStatements, writesIn, type CountingDatabase } from "../support/counting-db.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, listClubs, openPlayerWallets, seedSeason, T0 } from "../support/fixtures.js";
import { assertLedgerConsistent } from "../support/invariants.js";

type Move = Omit<Movement, "walletId" | "at"> & { at?: Date };

const AT = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("F11 T2: portfolio.postMany, vários movimentos de uma carteira de uma vez", () => {
  const t = useTestDatabase();
  let counting: CountingDatabase;
  let seasonId: number;
  /** Os clubes listados na temporada, em ordem de ticker. */
  let clubs: number[];

  beforeAll(async () => {
    // os 20 do seed e mais dois (a entrada no meio de uma temporada pode ter mais clubes listados)
    await t.db.insert(clubTable).values([
      { ticker: "XAA3", name: "Clube Extra A" },
      { ticker: "XBB3", name: "Clube Extra B" },
    ]);
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    const tickers = [...seeded.clubIds.keys()].sort();
    expect(tickers).toHaveLength(CLUBS.length + 2); // os clubes de CLUBS e 2 de fora
    await listClubs(t.db, seasonId, seeded.clubIds, tickers);
    clubs = tickers.map((ticker) => seeded.clubIds.get(ticker)!);
    counting = countingDatabase(t.conn.pool);
  });

  const full = (walletId: number, moves: Move[]): Movement[] => moves.map((m) => ({ walletId, ...m, at: m.at ?? T0 }));

  /** Aplica os movimentos com um laço de `post`, numa transação com a carteira travada. */
  const viaLoop = (walletId: number, moves: Move[], db: Database = t.db) =>
    withTransaction(db, async (tx) => {
      await lockWallets(tx, [walletId]);
      const results: PostResult[] = [];
      for (const m of full(walletId, moves)) results.push(await post(tx, m));
      return results;
    });

  /** Aplica os mesmos movimentos com um `postMany` só. */
  const viaMany = (walletId: number, moves: Move[], db: Database = t.db) =>
    withTransaction(db, async (tx) => {
      await lockWallets(tx, [walletId]);
      return postMany(tx, full(walletId, moves));
    });

  const refused = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof LedgerError) return error.code;
      throw error;
    }
    throw new Error("era para recusar");
  };

  /** Tudo o que a carteira tem no banco, sem o que muda de uma carteira para outra (ids, dono). */
  async function stateOf(walletId: number) {
    const [{ id: _id, userId: _user, ...wallet }] = (await t.db.select().from(wallets).where(eq(wallets.id, walletId))) as [
      typeof wallets.$inferSelect,
    ];
    const pos = (await t.db.select().from(positions).where(eq(positions.walletId, walletId)).orderBy(asc(positions.clubId))).map(
      ({ walletId: _w, ...p }) => p,
    );
    const entries = (
      await t.db.select().from(walletEntries).where(eq(walletEntries.walletId, walletId)).orderBy(asc(walletEntries.id))
    ).map(({ id: _i, walletId: _w, ...e }) => e);
    return { wallet, positions: pos, entries };
  }

  /** Um resultado de `post` sem o que muda de uma carteira para outra. */
  const comparable = (r: PostResult) => {
    const { id: _i, walletId: _w, ...entry } = r.entry;
    const { id: _id, userId: _u, ...wallet } = r.wallet;
    const position = r.position && (({ walletId: _pw, ...p }) => p)(r.position);
    return { entry, wallet, position };
  };

  const twoWallets = async (cash = INITIAL_CASH) => {
    const [a, b] = await openPlayerWallets(t.db, seasonId, 2, cash);
    return [a!, b!] as const;
  };

  /** Os dois caminhos nos mesmos movimentos: o estado gravado e os resultados por movimento iguais. */
  async function expectSameAsLoop(moves: Move[], before: Move[] = []) {
    const [loopWallet, manyWallet] = await twoWallets();
    if (before.length > 0) {
      await viaLoop(loopWallet, before);
      await viaLoop(manyWallet, before);
    }
    const loop = await viaLoop(loopWallet, moves);
    const many = await viaMany(manyWallet, moves);
    expect(await stateOf(manyWallet)).toEqual(await stateOf(loopWallet));
    expect(many.results.map(comparable)).toEqual(loop.map(comparable));
    // o que o postMany devolve além disso: as linhas na ordem, a carteira e as posições finais
    expect(many.entries).toEqual(many.results.map((r) => r.entry));
    expect(many.entries.map((e) => e.id)).toEqual([...many.entries.map((e) => e.id)].sort((x, y) => x - y));
    expect(many.wallet).toEqual((await t.db.select().from(wallets).where(eq(wallets.id, manyWallet)))[0]);
    const finalPositions = await t.db.select().from(positions).where(eq(positions.walletId, manyWallet));
    const touched = new Set(moves.filter((m) => m.clubId !== undefined).map((m) => m.clubId!));
    expect([...many.positions.values()].sort((x, y) => x.clubId - y.clubId)).toEqual(
      finalPositions.filter((p) => touched.has(p.clubId)).sort((x, y) => x.clubId - y.clubId),
    );
    await assertLedgerConsistent(t.db, seasonId);
    return { loop, many, manyWallet };
  }

  const buy = (clubId: number, quantity: number, price: number, kind: Movement["kind"] = "trade"): Move => ({
    kind,
    clubId,
    sharesDelta: quantity,
    cashDelta: -quantity * price,
    price,
    costBasis: "purchase",
    ref: { type: kind, id: clubId },
  });
  const sell = (clubId: number, quantity: number, price: number): Move => ({
    kind: "trade",
    clubId,
    sharesDelta: -quantity,
    cashDelta: quantity * price,
    price,
    costBasis: "sale",
    ref: { type: "trade", id: 77 },
  });

  it("equivalência: carteira índice em vários clubes, compra e venda no mesmo clube, dividendo, reserva e estorno", async () => {
    const [a, b, c] = clubs;
    await expectSameAsLoop([
      buy(a!, 120, 4000, "index_entry"),
      buy(b!, 75, 3333, "index_entry"),
      buy(c!, 33, 4127, "index_entry"),
      { ...buy(a!, 40, 4450), at: AT(5) },
      { ...sell(a!, 55, 4700), at: AT(6) },
      { kind: "dividend", clubId: b!, cashDelta: 36_000, price: 30, ref: { type: "payout_event", id: 7 }, at: AT(7) },
      { kind: "order_reserve", reservedCashDelta: 445_000, openOrdersDelta: 1, ref: { type: "order", id: 1 } },
      { kind: "order_reserve", clubId: c!, reservedSharesDelta: 20, openOrdersDelta: 1, ref: { type: "order", id: "2" } },
      { kind: "order_release", reservedCashDelta: -445_000, openOrdersDelta: -1 },
      { kind: "complement", clubId: b!, cashDelta: 1_200, reason: "placar corrigido" },
      { kind: "adjustment", cashDelta: -500, reason: "acerto" },
    ]);
  });

  it("equivalência com posições que já existiam e um estorno que deixa o caixa negativo no meio", async () => {
    const [a, b] = clubs;
    const { many } = await expectSameAsLoop(
      [
        { kind: "reversal", clubId: b!, cashDelta: -(INITIAL_CASH - 400_000 + 30_000), reason: "pagamento desfeito" },
        { kind: "dividend", clubId: a!, cashDelta: 10_000 },
        { ...sell(a!, 100, 4100), at: AT(3) },
      ],
      [buy(a!, 100, 4000)],
    );
    expect(many.results.map((r) => r.entry.cashAfter)).toEqual([-30_000, -20_000, 390_000]);
  });

  it("várias linhas do mesmo clube no lote: a ordem conta e o custo médio sai igual ao do laço", async () => {
    const [a] = clubs;
    const { many } = await expectSameAsLoop([
      buy(a!, 10, 4000),
      buy(a!, 30, 4533),
      sell(a!, 15, 5000),
      buy(a!, 7, 3001),
      sell(a!, 32, 3999),
      { kind: "adjustment", clubId: a!, sharesDelta: 3, price: 4200, costBasis: "purchase", reason: "crédito do admin" },
      { kind: "adjustment", clubId: a!, sharesDelta: -2, costBasis: "debit", reason: "débito do admin" },
    ]);
    const pos = many.positions.get(a!)!;
    expect(pos.shares).toBe(10 + 30 - 15 + 7 - 32 + 3 - 2);
    expect(pos.cost).toBeGreaterThan(0);
    // só as vendas têm resultado realizado (o débito do admin tira na proporção, sem resultado)
    expect(many.results.map((r) => r.entry.realized !== null)).toEqual([false, false, true, false, true, false, false]);
  });

  it("22 clubes de carteira índice em no máximo 6 comandos SQL, com o extrato na ordem dos movimentos", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    const moves = clubs.map((clubId, i) => buy(clubId, 50 + i, 4000 + 13 * i, "index_entry"));
    const { result, statements } = await withTransaction(counting.db, async (tx) => {
      await lockWallets(tx, [w!]);
      return countStatements(counting, () => postMany(tx, full(w!, moves)));
    });
    expect(statements.length).toBeLessThanOrEqual(6);
    expect(writesIn(statements)).toHaveLength(3);
    expect(result.entries.map((e) => [e.clubId, e.sharesDelta])).toEqual(moves.map((m) => [m.clubId, m.sharesDelta]));
    let cash = INITIAL_CASH;
    expect(result.entries.map((e) => e.cashAfter)).toEqual(moves.map((m) => (cash += m.cashDelta!)));
    expect(result.wallet!.cash).toBe(cash);
    expect(result.positions.size).toBe(CLUBS.length + 2);
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("lista vazia não manda comando nenhum", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    const { result, statements } = await withTransaction(counting.db, async (tx) => {
      await lockWallets(tx, [w!]);
      return countStatements(counting, () => postMany(tx, []));
    });
    expect(statements).toEqual([]);
    expect(result.entries).toEqual([]);
    expect(result.results).toEqual([]);
  });

  describe("recusa o que o post recusa, com o mesmo código, sem escrever nada", () => {
    /** Recusa pelos dois caminhos; o postMany não manda escrita nenhuma e nada muda na carteira. */
    async function expectRefusal(code: string, moves: Move[], before: Move[] = []) {
      const [loopWallet, manyWallet] = await twoWallets(1_000_000);
      if (before.length > 0) {
        await viaLoop(loopWallet, before);
        await viaLoop(manyWallet, before);
      }
      expect(await refused(viaLoop(loopWallet, moves))).toBe(code);
      const beforeState = await stateOf(manyWallet);
      const mark = counting.mark();
      expect(await refused(viaMany(manyWallet, moves, counting.db))).toBe(code);
      expect(writesIn(counting.since(mark))).toEqual([]);
      expect(await stateOf(manyWallet)).toEqual(beforeState);
    }

    const [a, b] = [0, 1];

    it("caixa negativo no meio do lote, mesmo que o fim do lote cubra", async () => {
      await expectRefusal("negative_cash", [
        buy(clubs[a]!, 200, 4000),
        buy(clubs[b]!, 60, 4000),
        { kind: "dividend", clubId: clubs[a]!, cashDelta: 5_000_000 },
      ]);
    });

    it("caixa reservado acima do caixa", async () => {
      await expectRefusal("reserved_exceeds_cash", [
        buy(clubs[a]!, 100, 4000),
        { kind: "order_reserve", reservedCashDelta: 700_000, openOrdersDelta: 1 },
      ]);
    });

    it("ações reservadas acima do total", async () => {
      await expectRefusal("reserved_exceeds_shares", [
        buy(clubs[a]!, 10, 4000),
        { kind: "order_reserve", clubId: clubs[a]!, reservedSharesDelta: 11, openOrdersDelta: 1 },
      ]);
    });

    it("ações negativas e reservado negativo", async () => {
      await expectRefusal("negative_shares", [buy(clubs[a]!, 10, 4000), sell(clubs[a]!, 11, 4000)]);
      await expectRefusal("negative_reserved_cash", [{ kind: "order_release", reservedCashDelta: -1 }]);
      await expectRefusal("negative_open_orders", [{ kind: "order_release", openOrdersDelta: -1 }]);
    });

    it("movimento de ação sem custo, sem clube, sem preço, sem motivo, origem trocada", async () => {
      const first = buy(clubs[a]!, 10, 4000);
      await expectRefusal("cost_basis_required", [first, { kind: "trade", clubId: clubs[a]!, sharesDelta: 1, cashDelta: -4000, price: 4000 }]);
      await expectRefusal("club_required", [first, { kind: "dividend", cashDelta: 100 }]);
      await expectRefusal("price_required", [first, { ...buy(clubs[b]!, 1, 4000), price: undefined }]);
      await expectRefusal("reason_required", [first, { kind: "adjustment", cashDelta: 100 }]);
      await expectRefusal("cost_basis_mismatch", [first, { ...buy(clubs[b]!, 1, 4000), costBasis: "sale" }]);
      await expectRefusal("invalid_cents", [first, { kind: "adjustment", cashDelta: 1.5, reason: "x" }]);
    });

    it("o primeiro erro do lote vence, como no laço", async () => {
      // o caixa fica negativo no 1º; o 2º nem é válido: o laço para no 1º
      await expectRefusal("negative_cash", [buy(clubs[a]!, 300, 4000), { kind: "adjustment", cashDelta: 1 }]);
    });

    it("carteira não travada", async () => {
      const [w] = await openPlayerWallets(t.db, seasonId, 1);
      const moves = full(w!, [buy(clubs[a]!, 1, 4000)]);
      expect(await refused(withTransaction(t.db, (tx) => post(tx, moves[0]!)))).toBe("wallet_not_locked");
      expect(await refused(withTransaction(t.db, (tx) => postMany(tx, moves)))).toBe("wallet_not_locked");
    });

    it("movimentos de carteiras diferentes", async () => {
      const [w1, w2] = await twoWallets();
      const mixed = [...full(w1, [buy(clubs[a]!, 1, 4000)]), ...full(w2, [buy(clubs[a]!, 1, 4000)])];
      const mark = counting.mark();
      const code = await refused(
        withTransaction(counting.db, async (tx) => {
          await lockWallets(tx, [w1, w2]);
          return postMany(tx, mixed);
        }),
      );
      expect(code).toBe("wallet_mismatch");
      expect(writesIn(counting.since(mark))).toEqual([]);
    });
  });
});
