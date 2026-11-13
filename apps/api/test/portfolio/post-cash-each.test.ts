import { asc, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { lockWallets } from "../../src/infra/db/locks.js";
import { walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { LedgerError, post, postCashEach, type Movement } from "../../src/modules/portfolio/ledger/index.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, listClubs, openPlayerWallets, seedSeason, T0 } from "../support/fixtures.js";
import { assertLedgerConsistent } from "../support/invariants.js";

const C = new Date("2027-12-20T15:00:00Z");

/** O lançamento só de caixa em várias carteiras de uma vez (F15, T10), que o encerramento usa para zerar as carteiras. */
describe("F15 T10: portfolio.postCashEach, um movimento de caixa em cada uma de várias carteiras", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let clubId: number;

  beforeAll(async () => {
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    await listClubs(t.db, seasonId, seeded.clubIds, ["FLA3"]);
    clubId = seeded.clubIds.get("FLA3")!;
  });

  /** O estado de cada carteira sem o que muda de uma para outra (ids e dono). */
  async function stateOf(ids: number[]) {
    const out = [];
    for (const id of ids) {
      const [{ id: _id, userId: _u, ...wallet }] = (await t.db.select().from(wallets).where(eq(wallets.id, id))) as [typeof wallets.$inferSelect];
      const entries = (await t.db.select().from(walletEntries).where(eq(walletEntries.walletId, id)).orderBy(asc(walletEntries.id))).map(
        ({ id: _i, walletId: _w, ...e }) => e,
      );
      out.push({ wallet, entries });
    }
    return out;
  }

  /** Carteiras com caixas diferentes, inclusive negativo (um estorno) e zero. */
  async function wallets5(): Promise<number[]> {
    const ids = await openPlayerWallets(t.db, seasonId, 5);
    const deltas = [0, 123_45, -INITIAL_CASH, -(INITIAL_CASH + 50_000), 7];
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, ids);
      for (const [i, id] of ids.entries()) {
        if (deltas[i] === 0) continue;
        await post(tx, { walletId: id, at: T0, kind: "reversal", clubId, cashDelta: deltas[i]!, ref: { type: "test", id: i }, reason: "estorno de teste" });
      }
    });
    return ids;
  }

  const zeroing = async (ids: number[]): Promise<Movement[]> => {
    const rows = await t.db.select({ id: wallets.id, cash: wallets.cash }).from(wallets).where(inArray(wallets.id, ids)).orderBy(asc(wallets.id));
    return rows.map((w) => ({ walletId: w.id, at: C, kind: "season_close", cashDelta: -w.cash, ref: { type: "season", id: seasonId } }));
  };

  it("grava o mesmo estado e o mesmo extrato que um laço de post (caixa positivo, negativo e zero vão a R$ 0,00)", async () => {
    const loopIds = await wallets5();
    const eachIds = await wallets5();
    const loopMoves = await zeroing(loopIds);
    const eachMoves = await zeroing(eachIds);
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, loopIds);
      for (const m of loopMoves) await post(tx, m);
    });
    const entries = await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, eachIds);
      return postCashEach(tx, eachMoves);
    });
    expect(await stateOf(eachIds)).toEqual(await stateOf(loopIds));
    expect(entries.map((e) => e.walletId)).toEqual(eachMoves.map((m) => m.walletId));
    expect(entries.map((e) => e.id)).toEqual([...entries.map((e) => e.id)].sort((a, b) => a - b));
    for (const id of eachIds) expect((await t.db.select().from(wallets).where(eq(wallets.id, id)))[0]!.cash).toBe(0);
    await assertLedgerConsistent(t.db, seasonId);
  });

  it("recusa movimento de clube, carteira repetida, carteira não travada e a regra do livro, sem gravar nada", async () => {
    const ids = await openPlayerWallets(t.db, seasonId, 3);
    const count = async () => Number((await t.db.execute(sql`select count(*)::int as n from futbolsa.wallet_entries`)).rows[0]!.n);
    const before = await count();
    const refused = async (moves: Movement[], lock: number[] = ids) => {
      try {
        await withTransaction(t.db, async (tx) => {
          await lockWallets(tx, lock);
          await postCashEach(tx, moves);
        });
      } catch (error) {
        if (error instanceof LedgerError) return error.code;
        throw error;
      }
      throw new Error("era para recusar");
    };
    const cash = (walletId: number, cashDelta: number, kind: Movement["kind"] = "season_close"): Movement => ({ walletId, at: C, kind, cashDelta });

    expect(await refused([cash(ids[0]!, -1), { ...cash(ids[1]!, 10, "dividend"), clubId, reason: "x" }])).toBe("cash_only");
    expect(await refused([cash(ids[0]!, -1), cash(ids[0]!, -1)])).toBe("wallet_mismatch");
    expect(await refused([cash(ids[0]!, -1), cash(ids[2]!, -1)], [ids[0]!])).toBe("wallet_not_locked");
    // a terceira deixaria o caixa negativo numa linha que não pode: nada das duas primeiras fica gravado
    expect(await refused([cash(ids[0]!, -1), cash(ids[1]!, -1), cash(ids[2]!, -(INITIAL_CASH + 1), "trade")])).toBe("negative_cash");
    expect(await count()).toBe(before);
    for (const id of ids) expect((await t.db.select().from(wallets).where(eq(wallets.id, id)))[0]!.cash).toBe(INITIAL_CASH);
  });

  it("sem movimentos não faz nada", async () => {
    const entries = await withTransaction(t.db, (tx) => postCashEach(tx, []));
    expect(entries).toEqual([]);
  });
});
