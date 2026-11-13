import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { orders, positions, users, wallets } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { assertLedgerConsistent, assertOpenOrdersCounter, assertReservesMatchOrders, assertSharesConserved } from "../support/invariants.js";
import { marketSeason, type MarketSeason } from "../market/helpers.js";
import { giveShares, openTreasury, syncTotalShares } from "../market/order-helpers.js";

// F14, T3 e T5 (concorrência): bloqueio contra ordens, dois admins se bloqueando e ajuste contra exclusão.

const TUESDAY = new Date("2027-04-06T18:00:00Z");
const CASH = 1_000_000;
const REPS = 10;

describe("admin de jogadores: concorrência", () => {
  const database = useTestDatabase(30);
  const clock = new FixedClock(TUESDAY);
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let admin: TestAccount;
  let treasury: number;

  const auth = async (a: TestAccount) => bearer(await a.tokenWith({ at: clock.now() }));
  const call = async (a: TestAccount, method: "POST" | "DELETE", url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, payload, headers: { ...(await auth(a)), ...headers } });

  const player = async () => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }], CASH);
    await giveShares(database.db, wallet!, s.clubIds.get("PAL3")!, 50);
    await syncTotalShares(database.db, s.seasonId);
    return { account, wallet: wallet! };
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    admin = await createAccount(database.db, { role: "admin" });
    treasury = await openTreasury(database.db, s.seasonId);
    await giveShares(database.db, treasury, s.clubIds.get("FLA3")!, 100_000);
    await syncTotalShares(database.db, s.seasonId);
  });
  afterAll(async () => {
    await assertLedgerConsistent(database.db, s.seasonId);
    await assertSharesConserved(database.db, s.seasonId);
    await assertOpenOrdersCounter(database.db, s.seasonId);
    await assertReservesMatchOrders(database.db, s.seasonId);
    await app.close();
  });

  it("admin 25: o bloqueio chegando enquanto o jogador manda ordens termina sem ordem aberta e com as reservas certas", async () => {
    for (let i = 0; i < REPS; i++) {
      const p = await player();
      const sending = Array.from({ length: 6 }, (_, n) =>
        call(p.account, "POST", "/orders", { ticker: "PAL3", side: n % 2 ? "buy" : "sell", type: "limit", quantity: 1, limitPrice: n % 2 ? 3900 : 4400 }),
      );
      const blocking = call(admin, "POST", `/admin/players/${p.account.id}/block`, { reason: "bloqueio concorrente" });
      const results = await Promise.all([...sending, blocking]);
      expect(results[results.length - 1]!.statusCode).toBe(200);
      for (const r of results.slice(0, -1)) expect([201, 403]).toContain(r.statusCode);
      const open = await database.db.select().from(orders).where(and(eq(orders.walletId, p.wallet), eq(orders.status, "open")));
      expect(open).toEqual([]);
      const [w] = await database.db.select().from(wallets).where(eq(wallets.id, p.wallet));
      expect(w).toMatchObject({ reservedCash: 0, openOrders: 0 });
    }
  });

  it("dois admins bloqueando um ao outro ao mesmo tempo: um passa e o outro recebe last_admin", async () => {
    for (let i = 0; i < REPS; i++) {
      // deixa só estes dois como admins ativos
      await database.db.update(users).set({ role: "player" }).where(eq(users.role, "admin"));
      const a = await createAccount(database.db, { role: "admin" });
      const b = await createAccount(database.db, { role: "admin" });
      const [ra, rb] = await Promise.all([
        call(a, "POST", `/admin/players/${b.id}/block`, { reason: "um contra o outro" }),
        call(b, "POST", `/admin/players/${a.id}/block`, { reason: "um contra o outro" }),
      ]);
      const codes = [ra.statusCode, rb.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const refused = ra.statusCode === 409 ? ra : rb;
      expect(refused.json().code).toBe("last_admin");
    }
    admin = await createAccount(database.db, { role: "admin" });
  });

  it("dois admins excluindo o mesmo jogador ao mesmo tempo: um exclui (202) e o outro recebe 404, nunca 401", async () => {
    for (let i = 0; i < REPS; i++) {
      const p = await player();
      const body = { confirmNickname: p.account.nickname, reason: "exclusão concorrente" };
      const [a, b] = await Promise.all([call(admin, "DELETE", `/admin/players/${p.account.id}`, body), call(admin, "DELETE", `/admin/players/${p.account.id}`, body)]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([202, 404]);
    }
  });

  it("ajuste de ações e exclusão da mesma conta ao mesmo tempo: o ajuste entra antes e a exclusão leva tudo, ou é recusado", async () => {
    for (let i = 0; i < REPS; i++) {
      const p = await player();
      const [adjusting, deleting] = await Promise.all([
        call(admin, "POST", `/admin/players/${p.account.id}/adjust`, { asset: "shares", ticker: "FLA3", delta: 5, reason: "ajuste concorrente" }, { "idempotency-key": `k-${i}-${p.account.id}` }),
        call(admin, "DELETE", `/admin/players/${p.account.id}`, { confirmNickname: p.account.nickname, reason: "exclusão concorrente" }),
      ]);
      expect(deleting.statusCode).toBe(202);
      expect([200, 404]).toContain(adjusting.statusCode);
      // com a conta excluída, a carteira não fica com ação nenhuma
      const left = await database.db.select({ shares: positions.shares }).from(positions).where(eq(positions.walletId, p.wallet));
      expect(left.every((r) => r.shares === 0)).toBe(true);
    }
  });
});
