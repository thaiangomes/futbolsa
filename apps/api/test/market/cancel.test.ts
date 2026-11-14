import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelOrderResponseSchema, MARKET_ERROR_MESSAGES } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { lockClubs, withTransaction } from "../../src/infra/db/index.js";
import { orders, positions, seasonClubs, wallets } from "../../src/infra/db/schema/index.js";
import { EventBus, meChannel } from "../../src/infra/realtime/index.js";
import { AccountClosureHooks, AccountDeletionService } from "../../src/modules/accounts/index.js";
import {
  AuctionCloser,
  CancelService,
  ClubsNotLockedError,
  MarketClosureHook,
  type OrderService,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  giveShares,
  openOrderIds,
  openPlayer,
  openTreasury,
  orderInputs,
  orderRow,
  orderService,
  positionOf,
  rejected,
  rolledBack,
  setTunnelState,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// T6 do Plano do livro de ofertas e formador: cancelar ordens (Livro de ofertas 16 e 41; Admin 24; Conta e login 22),
// pelo serviço, pela rota e pelo gancho de encerramento da conta.

/** Terça, 6 de abril de 2027, 10h05 de Brasília. */
const NOW = new Date("2027-04-06T13:05:00Z");
const TICKERS = ["FLA3", "PAL3", "SPT3", "COR3"];
const RICH = 10_000_000;

describe("cancelar ordens pelo serviço", () => {
  const t = useTestDatabase(5);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let service: OrderService;
  let cancels: CancelService;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number | undefined;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  /** Cada teste roda numa transação desfeita no fim e termina conferindo as invariantes do dinheiro e do livro. */
  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      await openTreasury(db, seasonId);
      ({ service } = orderService(db));
      cancels = new CancelService(db, new PortfolioLedger());
      o = orderInputs({ seasonId, now: NOW });
      cashBefore = undefined;
      await body();
      if (cashBefore === undefined) throw new Error("o teste não chamou ready() depois de montar as carteiras");
      await assertMarketInvariants(db, seasonId, cashBefore);
    });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const player = () => openPlayer(db, seasonId, RICH);
  const holder = async (ticker: string, shares: number) => {
    const wallet = await player();
    await giveShares(db, wallet, club(ticker), shares);
    return wallet;
  };
  const ready = async () => {
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  };
  const cancel = (walletId: number, orderId: number, now = NOW) => cancels.cancelOrder({ walletId, orderId, now });

  it("livro 16: cancelar a venda de 500 FLA3 libera as 500 e tira a ordem do livro", scene(async () => {
    const ana = await holder("FLA3", 500);
    await ready();
    const sale = accepted(await service.place(o.sellLimit(ana, "FLA3", 500, 4200)));
    expect(await positionOf(db, ana, club("FLA3"))).toMatchObject({ shares: 500, reservedShares: 500, free: 0 });

    const r = await cancel(ana, sale.order.id, new Date("2027-04-06T13:10:00Z"));
    if (!r.ok) throw new Error(r.code);
    expect(r.order).toMatchObject({ id: sale.order.id, status: "cancelled", cancelReason: "player", filled: 0, reservedCash: 0 });
    expect(r.order.updatedAt).toEqual(new Date("2027-04-06T13:10:00Z"));
    expect(await positionOf(db, ana, club("FLA3"))).toEqual({ shares: 500, reservedShares: 0, free: 500 });
    expect(await openOrderIds(db, club("FLA3"))).toEqual([]);
    expect(await walletOf(db, ana)).toMatchObject({ openOrders: 0 });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]!.entry).toMatchObject({ kind: "order_release", reservedSharesDelta: -500, reservedCashDelta: 0 });
    expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "cancelled", cancelReason: "player" });
  }));

  it("carteira 36: cancelar a compra que executou em parte devolve só o caixa do que faltava (60 × R$ 40,00)", scene(async () => {
    const ana = await player();
    const bruno = await holder("FLA3", 40);
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 40, 4000)));
    const purchase = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4000)));
    expect(purchase.order).toMatchObject({ filled: 40, status: "open", reservedCash: 240_000 });

    const r = await cancel(ana, purchase.order.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.order).toMatchObject({ filled: 40, status: "cancelled", reservedCash: 0 });
    expect(r.cash).toEqual({ total: RICH - 160_000, reserved: 0, free: RICH - 160_000 });
    expect(await positionOf(db, ana, club("FLA3"))).toMatchObject({ shares: 40 });
  }));

  it("cancelar ordem de outra pessoa ou que não existe dá order_not_found, sem mexer em nada", scene(async () => {
    const ana = await holder("FLA3", 10);
    const bruno = await player();
    await ready();
    const sale = accepted(await service.place(o.sellLimit(ana, "FLA3", 10, 4100)));
    expect(await cancel(bruno, sale.order.id)).toEqual({ ok: false, code: "order_not_found" });
    expect(await cancel(ana, 999_999_999)).toEqual({ ok: false, code: "order_not_found" });
    expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "open" });
    expect(await positionOf(db, ana, club("FLA3"))).toMatchObject({ reservedShares: 10 });
  }));

  it("cancelar ordem executada ou já cancelada dá order_not_open", scene(async () => {
    const ana = await holder("FLA3", 20);
    const bruno = await player();
    await ready();
    const sold = accepted(await service.place(o.sellLimit(ana, "FLA3", 10, 4000)));
    accepted(await service.place(o.buyLimit(bruno, "FLA3", 10, 4000)));
    expect(await cancel(ana, sold.order.id)).toEqual({ ok: false, code: "order_not_open" });

    const other = accepted(await service.place(o.sellLimit(ana, "FLA3", 10, 4100)));
    expect((await cancel(ana, other.order.id)).ok).toBe(true);
    expect(await cancel(ana, other.order.id)).toEqual({ ok: false, code: "order_not_open" });
  }));

  it("admin 24: com o FLA3 suspenso, cancelar a venda é aceito e as ações voltam; na retomada, a venda que ficou executa", scene(async () => {
    const ana = await holder("FLA3", 10);
    const bruno = await holder("FLA3", 10);
    const carla = await player();
    await ready();
    const ofAna = accepted(await service.place(o.sellLimit(ana, "FLA3", 10, 4000)));
    const ofBruno = accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4000)));

    const where = and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club("FLA3")));
    await db.update(seasonClubs).set({ suspendedReason: "Placar em revisão" }).where(where);
    expect((await cancel(ana, ofAna.order.id)).ok).toBe(true);
    expect(await positionOf(db, ana, club("FLA3"))).toMatchObject({ reservedShares: 0, free: 10 });
    expect(rejected(await service.place(o.buyLimit(carla, "FLA3", 10, 4000)))).toMatchObject({ code: "club_suspended", reason: "Placar em revisão" });

    await db.update(seasonClubs).set({ suspendedReason: null }).where(where);
    const r = accepted(await service.place(o.buyLimit(carla, "FLA3", 10, 4000)));
    expect(r.trades).toEqual([expect.objectContaining({ sellOrderId: ofBruno.order.id, quantity: 10, price: 4000 })]);
  }));

  it("livro 41: cancelar a ordem que está no leilão devolve a reserva para o livre", scene(async () => {
    const ana = await player();
    await ready();
    await setTunnelState(db, seasonId, club("FLA3"), { auctionOpenedAt: new Date("2027-04-06T12:00:00Z"), auctionUntil: new Date("2027-04-06T15:00:00Z") });
    const inAuction = accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4400)));
    expect(inAuction.order).toMatchObject({ status: "open", reservedCash: 44_000 });
    expect(await walletOf(db, ana)).toMatchObject({ reservedCash: 44_000 });

    const r = await cancel(ana, inAuction.order.id);
    expect(r.ok).toBe(true);
    expect(await walletOf(db, ana)).toMatchObject({ reservedCash: 0, free: RICH, openOrders: 0 });
    await setTunnelState(db, seasonId, club("FLA3"), { auctionOpenedAt: null, auctionUntil: null });
  }));

  it("com o leilão vencido, o cancelamento fecha o leilão antes (numa transação própria) e cancela depois; sem quem feche, é erro", scene(async () => {
    const ana = await player();
    await ready();
    await setTunnelState(db, seasonId, club("PAL3"), { auctionOpenedAt: new Date("2027-04-06T09:00:00Z"), auctionUntil: new Date("2027-04-06T12:00:00Z") });
    const order = accepted(await service.place(o.buyLimit(ana, "PAL3", 5, 4000, { now: new Date("2027-04-06T11:00:00Z") })));

    await expect(cancel(ana, order.order.id)).rejects.toThrow(/AuctionCloser/);
    let closes = 0;
    const closer = new (class extends AuctionCloser {
      async closeAuction(season: number, ticker: string): Promise<void> {
        closes++;
        await withTransaction(db, async (tx) => {
          await lockClubs(tx, season, [ticker]);
          await setTunnelState(tx.db as unknown as Database, season, club("PAL3"), { auctionOpenedAt: null, auctionUntil: null });
        });
      }
    })();
    const withCloser = new CancelService(db, new PortfolioLedger(), closer);
    expect((await withCloser.cancelOrder({ walletId: ana, orderId: order.order.id, now: NOW })).ok).toBe(true);
    expect(closes).toBe(1);
  }));

  it("cancelOrders só das compras (o estorno da F12): as compras saem com o motivo, a venda fica", scene(async () => {
    const ana = await holder("SPT3", 10);
    await ready();
    const b1 = accepted(await service.place(o.buyLimit(ana, "FLA3", 5, 3900)));
    const b2 = accepted(await service.place(o.buyLimit(ana, "PAL3", 5, 3900)));
    const s1 = accepted(await service.place(o.sellLimit(ana, "SPT3", 10, 4100)));

    const out = await withTransaction(db, async (tx) => {
      await lockClubs(tx, seasonId, ["FLA3", "PAL3", "SPT3"]);
      return cancels.cancelOrders(tx, ana, { side: "buy" }, "reversal", NOW);
    });
    expect(out.orders.map((x) => [x.id, x.status, x.cancelReason])).toEqual([
      [b1.order.id, "cancelled", "reversal"],
      [b2.order.id, "cancelled", "reversal"],
    ]);
    expect(out.posts.map((p) => p.entry.reservedCashDelta)).toEqual([-19_500, -19_500]);
    expect(await orderRow(db, s1.order.id)).toMatchObject({ status: "open" });
    expect(await walletOf(db, ana)).toMatchObject({ reservedCash: 0, openOrders: 1 });
  }));

  it("cancelOrders de certos clubes cancela só as ordens deles", scene(async () => {
    const ana = await player();
    await ready();
    accepted(await service.place(o.buyLimit(ana, "FLA3", 5, 3900)));
    const keep = accepted(await service.place(o.buyLimit(ana, "PAL3", 5, 3900)));
    const out = await withTransaction(db, async (tx) => {
      await lockClubs(tx, seasonId, ["FLA3"]);
      return cancels.cancelOrders(tx, ana, { tickers: ["FLA3"] }, "bot_off", NOW);
    });
    expect(out.orders.map((x) => x.ticker)).toEqual(["FLA3"]);
    expect(await orderRow(db, keep.order.id)).toMatchObject({ status: "open" });
  }));

  it("cancelOrders com uma ordem num clube não travado pede a repetição da transação (ClubsNotLockedError, 40001)", scene(async () => {
    const ana = await player();
    await ready();
    accepted(await service.place(o.buyLimit(ana, "FLA3", 5, 3900)));
    accepted(await service.place(o.buyLimit(ana, "COR3", 5, 3900)));
    const error = await withTransaction(db, async (tx) => {
      await lockClubs(tx, seasonId, ["FLA3"]);
      return cancels.cancelOrders(tx, ana, {}, "blocked", NOW);
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClubsNotLockedError);
    expect((error as ClubsNotLockedError).tickers).toEqual(["COR3"]);
    expect(await walletOf(db, ana)).toMatchObject({ openOrders: 2 });
  }));

  it("o gancho de encerramento: os clubes das ordens abertas, e o cancelamento de todas com o motivo blocked", scene(async () => {
    const ana = await holder("PAL3", 10);
    await ready();
    accepted(await service.place(o.buyLimit(ana, "FLA3", 5, 3900)));
    accepted(await service.place(o.sellLimit(ana, "PAL3", 10, 4100)));
    const hook = new MarketClosureHook(cancels);
    await withTransaction(db, async (tx) => {
      const tickers = await hook.clubsToLock(tx, ana);
      expect(tickers).toEqual(["FLA3", "PAL3"]);
      await lockClubs(tx, seasonId, tickers);
      await hook.cancelOpen(tx, ana, "blocked", NOW);
    });
    const rows = await db.select().from(orders).where(eq(orders.walletId, ana));
    expect(rows.map((r) => [r.status, r.cancelReason])).toEqual([
      ["cancelled", "blocked"],
      ["cancelled", "blocked"],
    ]);
    expect(await positionOf(db, ana, club("PAL3"))).toMatchObject({ reservedShares: 0 });
  }));
});

describe("cancelar pela rota e pela exclusão da conta", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date("2027-04-06T18:00:00Z"));
  let app: NestFastifyApplication;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let cashBefore: number;

  const playerWith = async (cash: number, shares?: { ticker: string; quantity: number }) => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, seasonId, [{ type: "user", userId: account.id }], cash);
    if (shares) await giveShares(database.db, wallet!, clubIds.get(shares.ticker)!, shares.quantity);
    return { account, wallet: wallet! };
  };
  const call = async (account: { tokenWith: (o: { at: Date }) => Promise<string> }, method: "POST" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: bearer(await account.tokenWith({ at: clock.now() })) });

  let ana: Awaited<ReturnType<typeof playerWith>>;
  let bruno: Awaited<ReturnType<typeof playerWith>>;
  let davi: Awaited<ReturnType<typeof playerWith>>;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    ({ seasonId, clubIds } = await marketSeason(database.db, { tickers: TICKERS }));
    treasury = await openTreasury(database.db, seasonId);
    ana = await playerWith(RICH, { ticker: "FLA3", quantity: 50 });
    bruno = await playerWith(RICH);
    // conta 22: Davi com 200 FLA3 e R$ 5.000,00 em caixa
    davi = await playerWith(500_000, { ticker: "FLA3", quantity: 200 });
    await syncTotalShares(database.db, seasonId);
    cashBefore = await totalCash(database.db, seasonId);
  });
  afterAll(() => app.close());

  it("DELETE /orders/:id cancela a própria ordem e devolve a ordem e o caixa; de outra pessoa dá 404, executada dá 409", async () => {
    const placed = await call(ana.account, "POST", "/orders", { ticker: "FLA3", side: "sell", type: "limit", quantity: 10, limitPrice: 4100 });
    expect(placed.statusCode).toBe(201);
    const id = placed.json().order.id as number;

    const foreign = await call(bruno.account, "DELETE", `/orders/${id}`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ code: "order_not_found", message: MARKET_ERROR_MESSAGES.order_not_found });

    const res = await call(ana.account, "DELETE", `/orders/${id}`);
    expect(res.statusCode).toBe(200);
    const body = cancelOrderResponseSchema.parse(res.json());
    expect(body.order).toMatchObject({ id, status: "cancelled", cancelReason: "player" });
    expect(body.cash).toEqual({ total: RICH, reserved: 0, free: RICH });
    expect(JSON.stringify(res.json())).not.toMatch(/wallet/i);

    const twice = await call(ana.account, "DELETE", `/orders/${id}`);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("order_not_open");

    expect((await call(ana.account, "DELETE", "/orders/abc")).statusCode).toBe(400);
    expect((await call(ana.account, "DELETE", "/orders/999999999")).statusCode).toBe(404);
    await assertMarketInvariants(database.db, seasonId, cashBefore);
  });

  it("o cancelamento avisa o dono depois do COMMIT: order.updated cancelada e wallet.changed com a reserva devolvida", async () => {
    const placed = await call(ana.account, "POST", "/orders", { ticker: "COR3", side: "buy", type: "limit", quantity: 2, limitPrice: 3900 });
    expect(placed.statusCode).toBe(201);
    const bus = app.get(EventBus, { strict: false });
    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    const sub = bus.subscribe(meChannel(ana.account.id), (e) => frames.push(JSON.parse(e.frame)));
    try {
      expect((await call(ana.account, "DELETE", `/orders/${placed.json().order.id}`)).statusCode).toBe(200);
    } finally {
      sub.unsubscribe();
    }
    expect(frames.find((f) => f.type === "order.updated")?.data).toMatchObject({ id: placed.json().order.id, status: "cancelled", cancelReason: "player" });
    expect(frames.find((f) => f.type === "wallet.changed")?.data).toMatchObject({ cash: RICH, reserved: 0 });
    expect(JSON.stringify(frames)).not.toMatch(/walletId|wallet_id/);
  });

  it("o MarketModule registra o gancho de encerramento das ordens no accounts", async () => {
    const hooks = app.get(AccountClosureHooks, { strict: false });
    const placed = await call(ana.account, "POST", "/orders", { ticker: "PAL3", side: "buy", type: "limit", quantity: 1, limitPrice: 3900 });
    expect(placed.statusCode).toBe(201);
    const tickers = await withTransaction(database.db, (tx) => hooks.clubsToLock(tx, ana.wallet));
    expect(tickers).toContain("PAL3");
    expect((await call(ana.account, "DELETE", `/orders/${placed.json().order.id}`)).statusCode).toBe(200);
  });

  it("conta 22: a exclusão cancela a venda aberta pelo gancho, com motivo deleted, e as 200 FLA3 vão para a tesouraria", async () => {
    const placed = await call(davi.account, "POST", "/orders", { ticker: "FLA3", side: "sell", type: "limit", quantity: 50, limitPrice: 4500 });
    expect(placed.statusCode).toBe(201);
    const id = placed.json().order.id as number;

    const result = await app.get(AccountDeletionService, { strict: false }).deleteAccount(davi.account.id);
    expect(result).toEqual({ walletCloseout: "done" });

    const [order] = await database.db.select().from(orders).where(eq(orders.id, id));
    expect(order).toMatchObject({ status: "cancelled", cancelReason: "deleted", reservedCash: 0 });
    const [wallet] = await database.db.select().from(wallets).where(eq(wallets.id, davi.wallet));
    expect(wallet).toMatchObject({ cash: 0, reservedCash: 0, openOrders: 0 });
    const [held] = await database.db.select().from(positions).where(and(eq(positions.walletId, davi.wallet), eq(positions.clubId, clubIds.get("FLA3")!)));
    expect(held).toMatchObject({ shares: 0, reservedShares: 0 });
    const [house] = await database.db.select().from(positions).where(and(eq(positions.walletId, treasury), eq(positions.clubId, clubIds.get("FLA3")!)));
    expect(house!.shares).toBe(200);
    // o caixa de Davi sumiu com a conta
    await assertMarketInvariants(database.db, seasonId, cashBefore - 500_000);
  });
});
