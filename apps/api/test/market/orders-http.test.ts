import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookViewSchema, listOrdersResponseSchema, MARKET_ERROR_MESSAGES, placeOrderResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { orders, seasonClubs, seasons, users } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { deferred, openWallets } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason, type MarketSeason } from "./helpers.js";
import { assertMarketInvariants, giveShares, syncTotalShares, waitForBlocked, walletOf } from "./order-helpers.js";

// T5 do Plano do livro de ofertas e formador: POST /orders e GET /orders pela rota, com login, conta bloqueada,
// suspensão e o limite do throttler (Livro de ofertas 21 e 22; Admin 23; Conta e login 5).

/** Terça, 6 de abril de 2027, 15h de Brasília. */
const TUESDAY = new Date("2027-04-06T18:00:00Z");
const CASH = 1_000_000;

describe("rotas de ordem (HTTP)", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(TUESDAY);
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let cashBefore: number;

  /** Um jogador com conta, carteira com R$ 10.000,00 e, se pedido, ações de um clube. */
  const player = async (shares?: { ticker: string; quantity: number }) => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }], CASH);
    if (shares) await giveShares(database.db, wallet!, s.clubIds.get(shares.ticker)!, shares.quantity);
    return { account, wallet: wallet! };
  };

  /** O token vale a partir do instante do relógio de teste. */
  const auth = async (account: TestAccount) => bearer(await account.tokenWith({ at: clock.now() }));
  const postOrder = async (account: TestAccount, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/orders", payload, headers: { ...(await auth(account)), ...headers } });
  const getOrders = async (account: TestAccount) => app.inject({ method: "GET", url: "/orders?status=open", headers: await auth(account) });

  const buy = (ticker: string, quantity: number, limitPrice: number) => ({ ticker, side: "buy", type: "limit", quantity, limitPrice });
  const sell = (ticker: string, quantity: number, limitPrice: number) => ({ ticker, side: "sell", type: "limit", quantity, limitPrice });

  let ana: Awaited<ReturnType<typeof player>>;
  let bruno: Awaited<ReturnType<typeof player>>;
  let carla: Awaited<ReturnType<typeof player>>;
  let davi: Awaited<ReturnType<typeof player>>;
  let elsa: Awaited<ReturnType<typeof player>>;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    ana = await player();
    bruno = await player({ ticker: "PAL3", quantity: 100 });
    carla = await player({ ticker: "SPT3", quantity: 10 });
    davi = await player();
    elsa = await player();
    await syncTotalShares(database.db, s.seasonId);
    cashBefore = await totalCash(database.db, s.seasonId);
  });
  afterAll(async () => {
    await assertMarketInvariants(database.db, s.seasonId, cashBefore);
    await app.close();
  });

  it("sem login, as três rotas de ordem dão 401", async () => {
    expect((await app.inject({ method: "POST", url: "/orders", payload: buy("FLA3", 1, 4000) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/orders" })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/orders/1" })).statusCode).toBe(401);
  });

  it("conta 5: com o e-mail sem confirmar, a ordem é recusada (403 email_not_confirmed)", async () => {
    const token = await ana.account.tokenWith({ at: clock.now(), emailVerified: false });
    const res = await app.inject({ method: "POST", url: "/orders", payload: buy("FLA3", 1, 4000), headers: bearer(token) });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("email_not_confirmed");
    expect(await walletOf(database.db, ana.wallet)).toMatchObject({ openOrders: 0, reservedCash: 0 });
  });

  it("livro 21: com a negociação abrindo em 2027-04-05 às 10h, a ordem das 9h59 é recusada e a das 10h00 é aceita, ao preço do corte", async () => {
    try {
      clock.set(new Date("2027-04-05T12:59:00Z"));
      const early = await postOrder(ana.account, buy("FLA3", 10, 4000));
      expect(early.statusCode).toBe(409);
      expect(early.json()).toEqual({ code: "market_closed", message: MARKET_ERROR_MESSAGES.market_closed });

      clock.set(new Date("2027-04-05T13:00:00Z"));
      const open = await postOrder(ana.account, buy("FLA3", 10, 3900));
      expect(open.statusCode).toBe(201);
      const r = placeOrderResponseSchema.parse(open.json());
      expect(r.order).toMatchObject({ ticker: "FLA3", status: "open", quantity: 10, reservedCash: 39_000 });
      expect(r.cash).toEqual({ total: CASH, reserved: 39_000, free: CASH - 39_000 });
      // sem negócio ainda, o preço exibido é o do IPO (o preço de corte)
      const book = bookViewSchema.parse((await app.inject({ method: "GET", url: "/clubs/FLA3/book" })).json());
      expect(book.price.displayed).toBe(4000);
    } finally {
      clock.set(TUESDAY);
    }
  });

  it("livro 22: com a negociação aberta, a ordem de domingo às 3h de Brasília é aceita", async () => {
    try {
      clock.set(new Date("2027-04-11T06:00:00Z")); // domingo, 3h de Brasília
      const res = await postOrder(ana.account, buy("COR3", 1, 4000));
      expect(res.statusCode).toBe(201);
      expect(placeOrderResponseSchema.parse(res.json()).order.status).toBe("open");
    } finally {
      clock.set(TUESDAY);
    }
  });

  it("admin 23: com o FLA3 suspenso, a ordem de FLA3 é recusada com o motivo, e a de PAL3 executa", async () => {
    const where = and(eq(seasonClubs.seasonId, s.seasonId), eq(seasonClubs.clubId, s.clubIds.get("FLA3")!));
    await database.db.update(seasonClubs).set({ suspendedReason: "Placar do jogo em revisão" }).where(where);
    try {
      const refused = await postOrder(davi.account, buy("FLA3", 5, 4000));
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("club_suspended");
      expect(refused.json().message).toContain("Placar do jogo em revisão");

      expect((await postOrder(bruno.account, sell("PAL3", 20, 4000))).statusCode).toBe(201);
      const res = await postOrder(davi.account, buy("PAL3", 20, 4000));
      expect(res.statusCode).toBe(201);
      const r = placeOrderResponseSchema.parse(res.json());
      expect(r.order).toMatchObject({ status: "filled", filled: 20 });
      expect(r.trades).toEqual([expect.objectContaining({ price: 4000, quantity: 20 })]);
      expect(JSON.stringify(r)).not.toMatch(/wallet|buyer|seller/i);
    } finally {
      await database.db.update(seasonClubs).set({ suspendedReason: null }).where(where);
    }
  });

  it("o mercado todo suspenso recusa com o motivo do mercado", async () => {
    await database.db.update(seasons).set({ suspendedReason: "Manutenção do jogo" }).where(eq(seasons.id, s.seasonId));
    try {
      const res = await postOrder(davi.account, buy("SPT3", 1, 4000));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "club_suspended", message: expect.stringContaining("Manutenção do jogo") });
    } finally {
      await database.db.update(seasons).set({ suspendedReason: null }).where(eq(seasons.id, s.seasonId));
    }
  });

  it("as recusas da ordem dão 422 com o código e a mensagem do contrato, e nada é gravado", async () => {
    const before = await walletOf(database.db, davi.wallet);
    const res = await postOrder(davi.account, buy("SPT3", 1, 4801));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ code: "price_out_of_band", message: MARKET_ERROR_MESSAGES.price_out_of_band });
    const noCash = await postOrder(davi.account, buy("SPT3", 1000, 4000));
    expect(noCash.json()).toMatchObject({ code: "insufficient_cash" });
    expect(await walletOf(database.db, davi.wallet)).toEqual(before);
  });

  it("corpo fora do esquema dá 400, e ticker não listado, 404", async () => {
    expect((await postOrder(davi.account, { ticker: "FLA3", side: "buy", type: "limit", quantity: 1 })).statusCode).toBe(400);
    expect((await postOrder(davi.account, { ...buy("FLA3", 1, 4000), wallet: 1 })).statusCode).toBe(400);
    const missing = await postOrder(davi.account, buy("ZZZ9", 1, 4000));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("not_found");
  });

  it("conta sem carteira na temporada: a ordem dá market_closed e a lista vem vazia", async () => {
    const stranger = await createAccount(database.db);
    const res = await postOrder(stranger, buy("FLA3", 1, 4000));
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("market_closed");
    expect(listOrdersResponseSchema.parse((await getOrders(stranger)).json())).toEqual({ orders: [] });
  });

  it("GET /orders: só as ordens abertas do próprio jogador, sem carteira", async () => {
    const res = await getOrders(ana.account);
    expect(res.statusCode).toBe(200);
    const list = listOrdersResponseSchema.parse(res.json());
    const mine = await database.db.select({ id: orders.id }).from(orders).where(and(eq(orders.walletId, ana.wallet), eq(orders.status, "open"))).orderBy(orders.id);
    expect(list.orders.map((o) => o.id)).toEqual(mine.map((o) => o.id));
    expect(list.orders.length).toBeGreaterThan(0);
    expect(list.orders.every((o) => o.status === "open")).toBe(true);
    expect(JSON.stringify(res.json())).not.toMatch(/wallet/i);
    // as ordens executadas de Davi não aparecem
    expect(listOrdersResponseSchema.parse((await getOrders(davi.account)).json()).orders).toEqual([]);
  });

  it("conta bloqueada: a ordem é recusada com account_blocked, e o bloqueado ainda lê as próprias ordens", async () => {
    expect((await postOrder(carla.account, sell("SPT3", 5, 4100))).statusCode).toBe(201);
    await database.db.update(users).set({ status: "blocked", blockedReason: "teste" }).where(eq(users.id, carla.account.id));
    try {
      const before = await walletOf(database.db, carla.wallet);
      const res = await postOrder(carla.account, sell("SPT3", 5, 4200));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ code: "account_blocked", message: MARKET_ERROR_MESSAGES.account_blocked });
      expect(await walletOf(database.db, carla.wallet)).toEqual(before);
      const list = listOrdersResponseSchema.parse((await getOrders(carla.account)).json());
      expect(list.orders).toEqual([expect.objectContaining({ ticker: "SPT3", side: "sell", quantity: 5, status: "open" })]);
    } finally {
      await database.db.update(users).set({ status: "active", blockedReason: null }).where(eq(users.id, carla.account.id));
    }
  });

  it("conta bloqueada no meio da ordem: o bloqueio que trava a carteira e confirma depois é visto pela ordem que esperava", async () => {
    const release = deferred();
    const locked = deferred();
    // o bloqueio da F14: trava a conta, marca bloqueada, trava a carteira e só confirma depois que a ordem esperar
    const blocking = withTransaction(database.db, async (tx) => {
      await tx.db.execute(sql`select id from futbolsa.users where id = ${elsa.account.id} for no key update`);
      await tx.db.update(users).set({ status: "blocked", blockedReason: "bloqueio no meio" }).where(eq(users.id, elsa.account.id));
      await lockWallets(tx, [elsa.wallet]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const order = postOrder(elsa.account, buy("FLA3", 1, 4000));
    await waitForBlocked(database.db, 1);
    release.resolve();
    await blocking;
    const res = await order;
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("account_blocked");
    expect(await walletOf(database.db, elsa.wallet)).toMatchObject({ openOrders: 0, reservedCash: 0 });
  });

  it("limite orders do throttler: a 61ª chamada no minuto dá 429", async () => {
    const fabio = await createAccount(database.db);
    const headers = await auth(fabio);
    // corpo inválido: não chega no banco, mas conta no limite (o throttler roda antes do pipe)
    for (let i = 0; i < 60; i++) {
      const res = await app.inject({ method: "POST", url: "/orders", payload: { ticker: "FLA3" }, headers });
      expect(res.statusCode).toBe(400);
    }
    const limited = await app.inject({ method: "POST", url: "/orders", payload: buy("FLA3", 1, 4000), headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe("too_many_requests");
    // outra pessoa não é afetada
    expect((await postOrder(davi.account, buy("FLA3", 1, 3900))).statusCode).toBe(201);
  });
});
