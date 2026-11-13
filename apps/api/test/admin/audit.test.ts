import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditResponseSchema, type AuditResponse } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { bots, users } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { insertTrade, marketSeason, type MarketSeason } from "../market/helpers.js";
import { openBot, openTreasury } from "../market/order-helpers.js";

// F14, T7: a auditoria de negócios (Admin 31 e 34).

describe("auditoria de negócios", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let admin: TestAccount;
  let ana: { account: TestAccount; wallet: number };
  let bruno: { account: TestAccount; wallet: number };
  let carla: { account: TestAccount; wallet: number };
  let house: number;
  let botWallet: number;
  let botId: number;
  const day = (h: number, m = 0) => new Date(Date.UTC(2027, 3, 6, h, m));

  const call = async (query: string): Promise<AuditResponse> => {
    const res = await app.inject({ method: "GET", url: `/admin/trades${query}`, headers: bearer(admin.token) });
    expect(res.statusCode, res.body).toBe(200);
    return auditResponseSchema.parse(res.json());
  };
  const player = async (nickname: string) => {
    const account = await createAccount(database.db, { nickname });
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    return { account, wallet: wallet! };
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    admin = await createAccount(database.db, { role: "admin" });
    ana = await player("Ana");
    bruno = await player("Bruno");
    carla = await player("Carla");
    house = await openTreasury(database.db, s.seasonId);
    botWallet = await openBot(database.db, s.seasonId, 1_000_000);
    botId = (await database.db.select({ id: bots.id }).from(bots))[0]!.id;
    const fla = s.clubIds.get("FLA3")!;
    const pal = s.clubIds.get("PAL3")!;
    // Ana compra 100 FLA3 de Bruno; Ana compra 50 FLA3 da casa; Carla compra do bot; dois negócios no mesmo instante
    await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: day(14), price: 4000, quantity: 100, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet });
    await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: day(15), price: 4100, quantity: 50, buyerWalletId: ana.wallet, sellerWalletId: house });
    await insertTrade(database.db, { seasonId: s.seasonId, clubId: pal, at: day(16), price: 3000, quantity: 7, buyerWalletId: carla.wallet, sellerWalletId: botWallet });
    await insertTrade(database.db, { seasonId: s.seasonId, clubId: pal, at: day(17), price: 3100, quantity: 1, buyerWalletId: bruno.wallet, sellerWalletId: carla.wallet });
    await insertTrade(database.db, { seasonId: s.seasonId, clubId: pal, at: day(17), price: 3200, quantity: 2, buyerWalletId: bruno.wallet, sellerWalletId: carla.wallet, inAuction: true });
  });
  afterAll(() => app.close());

  it("admin 31: jogador comum não acessa a auditoria", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/trades" }, { okStatus: 200 });
  });

  it("admin 34: filtrando por Ana e Bruno só aparece o negócio de 100 FLA3, com Ana compradora e Bruno vendedor", async () => {
    const r = await call(`?pair=${ana.account.id},${bruno.account.id}`);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({
      quantity: 100,
      price: 4000,
      value: 400_000,
      ticker: "FLA3",
      buyer: { kind: "player", label: "Ana", id: ana.account.id },
      seller: { kind: "player", label: "Bruno" },
    });
    // o par é o mesmo em qualquer ordem
    expect((await call(`?pair=${bruno.account.id},${ana.account.id}`)).trades).toHaveLength(1);
  });

  it("admin 34: sem o filtro de par aparece também o de 50 com a casa vendedora; bot e conta excluída têm rótulo próprio", async () => {
    const all = await call(`?player=${ana.account.id}`);
    expect(all.trades.map((t) => t.quantity)).toEqual([50, 100]);
    expect(all.trades[0]!.seller).toEqual({ kind: "house", id: null, label: "casa" });
    const withBot = await call("?club=PAL3");
    const fromBot = withBot.trades.find((t) => t.quantity === 7)!;
    expect(fromBot.seller).toEqual({ kind: "bot", id: `bot:${botId}`, label: `bot trader #${botId}` });
    await database.db.update(users).set({ status: "deleted", nickname: null, email: null }).where(eq(users.id, bruno.account.id));
    const deleted = (await call("?club=PAL3")).trades.find((t) => t.quantity === 1)!;
    expect(deleted.buyer).toMatchObject({ kind: "deleted", label: "conta excluída" });
    // o filtro pelo id da conta excluída continua achando os negócios dela
    expect((await call(`?player=${bruno.account.id}`)).trades).toHaveLength(3);
  });

  it("filtros de clube e de período (from inclusive, to exclusive) e o par com a casa e com o bot", async () => {
    expect((await call("?club=FLA3")).trades).toHaveLength(2);
    expect((await call(`?from=${day(15).toISOString()}&to=${day(17).toISOString()}`)).trades.map((t) => t.quantity)).toEqual([7, 50]);
    expect((await call(`?from=${day(17).toISOString()}`)).trades).toHaveLength(2);
    expect((await call(`?pair=${ana.account.id},house`)).trades.map((t) => t.quantity)).toEqual([50]);
    expect((await call(`?pair=bot:${botId},${carla.account.id}`)).trades.map((t) => t.quantity)).toEqual([7]);
    // conta sem carteira na temporada não tem negócio
    const stranger = await createAccount(database.db);
    expect((await call(`?player=${stranger.id}`)).trades).toEqual([]);
  });

  it("páginas sem repetir nem pular, com dois negócios no mesmo instante", async () => {
    // 205 negócios de 1 ação entre Ana e Carla, todos no mesmo instante, para passar da página de 200
    await database.db.execute(sql`
      insert into futbolsa.orders (season_id, club_id, wallet_id, side, type, quantity, filled, limit_price, status, created_at, updated_at)
      select ${s.seasonId}, ${s.clubIds.get("COR3")!}, w::bigint, side, 'limit', 1, 1, 4000, 'filled', ${day(20).toISOString()}::timestamptz, ${day(20).toISOString()}::timestamptz
      from (values (${ana.wallet}, 'buy'), (${carla.wallet}, 'sell')) v(w, side)`);
    const [buy, sell] = (await database.db.execute(sql`select id from futbolsa.orders where club_id = ${s.clubIds.get("COR3")!} order by id`)).rows.map((r) => Number(r.id));
    await database.db.execute(sql`
      insert into futbolsa.trades (season_id, club_id, at, price, quantity, buy_order_id, sell_order_id, buyer_wallet_id, seller_wallet_id, with_house, price_before, in_auction)
      select ${s.seasonId}, ${s.clubIds.get("COR3")!}, ${day(20).toISOString()}::timestamptz, 4000, 1, ${buy}, ${sell}, ${ana.wallet}, ${carla.wallet}, false, 4000, false
      from generate_series(1, 205)`);
    const first = await call(`?club=COR3`);
    expect(first.trades).toHaveLength(200);
    expect(first.nextCursor).not.toBeNull();
    const second = await call(`?club=COR3&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(second.trades).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.trades, ...second.trades].map((t) => t.id);
    expect(new Set(ids).size).toBe(205);
  });

  it("a contraparte nunca sai do /admin: o extrato do jogador não traz o outro lado", async () => {
    const res = await app.inject({ method: "GET", url: "/portfolio/entries", headers: bearer(await ana.account.tokenWith({ at: clock.now() })) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("Bruno");
    expect(res.body).not.toContain("casa");
  });

  it("admin 34 (desempenho): a consulta por jogador usa o índice de negócios por carteira, com 100 mil negócios", async () => {
    await database.db.execute(sql`
      insert into futbolsa.trades (season_id, club_id, at, price, quantity, buy_order_id, sell_order_id, buyer_wallet_id, seller_wallet_id, with_house, price_before, in_auction)
      select ${s.seasonId}, ${s.clubIds.get("SPT3")!}, ${day(21).toISOString()}::timestamptz + (g || ' seconds')::interval, 4000, 1,
             (select id from futbolsa.orders limit 1), (select id from futbolsa.orders limit 1 offset 1), ${bruno.wallet}, ${carla.wallet}, false, 4000, false
      from generate_series(1, 100000) g`);
    await database.db.execute(sql`analyze futbolsa.trades`);
    const plan = await database.db.execute(sql`
      explain select * from futbolsa.trades where buyer_wallet_id = ${ana.wallet} or seller_wallet_id = ${ana.wallet} order by at desc, id desc limit 201`);
    const text = plan.rows.map((r) => String(Object.values(r)[0])).join("\n");
    expect(text).not.toMatch(/Seq Scan on trades/);
    expect(text).toMatch(/trades_(buyer|seller)_at_idx/);
  });
});
