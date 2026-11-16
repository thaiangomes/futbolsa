import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listOrdersResponseSchema, MARKET_ERROR_MESSAGES, replaceOrderResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { orders } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason, type MarketSeason } from "./helpers.js";
import { assertMarketInvariants, giveShares, syncTotalShares } from "./order-helpers.js";

// Itens 12 das melhorias da partida: PUT /orders/:id, a edição como troca atômica (Livro de ofertas e formador de mercado,
// critérios 57 a 59), pela rota, com login.

/** Terça, 6 de abril de 2027, 15h de Brasília (o mercado aberto). */
const TUESDAY = new Date("2027-04-06T18:00:00Z");
const CASH = 1_000_000;
const TICKERS = ["FLA3", "PAL3", "SPT3", "COR3"] as const;

describe("PUT /orders/:id: editar uma ordem aberta (troca atômica)", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(TUESDAY);
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let cashBefore: number;
  type Player = { account: TestAccount; walletId: number };
  const buyers: Player[] = [];
  const sellers: Player[] = [];

  const makePlayer = async (shares = false): Promise<Player> => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }], CASH);
    if (shares) for (const t of TICKERS) await giveShares(database.db, wallet!, s.clubIds.get(t)!, 500);
    return { account, walletId: wallet! };
  };
  const auth = async (p: Player) => bearer(await p.account.tokenWith({ at: clock.now() }));
  const post = async (p: Player, payload: object) => app.inject({ method: "POST", url: "/orders", payload, headers: await auth(p) });
  const put = async (p: Player, id: number, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: "PUT", url: `/orders/${id}`, payload, headers: { ...(await auth(p)), ...headers } });
  const del = async (p: Player, id: number) => app.inject({ method: "DELETE", url: `/orders/${id}`, headers: await auth(p) });
  const open = async (p: Player) =>
    listOrdersResponseSchema.parse((await app.inject({ method: "GET", url: "/orders?status=open", headers: await auth(p) })).json()).orders;
  const order = (ticker: string, side: "buy" | "sell", quantity: number, limitPrice: number) => ({ ticker, side, type: "limit", quantity, limitPrice });
  const idOf = async (res: Awaited<ReturnType<typeof post>>) => {
    expect(res.statusCode).toBe(201);
    return res.json().order.id as number;
  };
  const row = async (id: number) => (await database.db.select().from(orders).where(eq(orders.id, id)))[0]!;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    for (let i = 0; i < 8; i++) buyers.push(await makePlayer());
    for (let i = 0; i < 3; i++) sellers.push(await makePlayer(true));
    await syncTotalShares(database.db, s.seasonId);
    cashBefore = await totalCash(database.db, s.seasonId);
  });
  afterAll(async () => {
    await assertMarketInvariants(database.db, s.seasonId, cashBefore);
    await app.close();
  });

  it("sem login dá 401", async () => {
    expect((await app.inject({ method: "PUT", url: "/orders/1", payload: { quantity: 1, limitPrice: 4000 } })).statusCode).toBe(401);
  });

  it("livro 57: a ordem antiga sai e a nova entra numa operação só, com a reserva recalculada (R$ 4.000,00 → R$ 4.920,00)", async () => {
    const [ana] = buyers as [Player];
    const id = await idOf(await post(ana, order("FLA3", "buy", 100, 4000)));
    expect((await open(ana))[0]).toMatchObject({ id, reservedCash: 400_000 });

    const res = await put(ana, id, { quantity: 120, limitPrice: 4100 });
    expect(res.statusCode).toBe(200);
    const body = replaceOrderResponseSchema.parse(res.json());
    expect(body.replaced).toMatchObject({ id, status: "cancelled", cancelReason: "player", reservedCash: 0 });
    expect(body.order).toMatchObject({ side: "buy", ticker: "FLA3", quantity: 120, limitPrice: 4100, reservedCash: 492_000, status: "open" });
    expect(body.order.id).toBeGreaterThan(id);
    expect(body.cash.reserved).toBe(492_000);
    // uma única ordem de Ana no livro
    expect((await open(ana)).map((o) => o.id)).toEqual([body.order.id]);
    await del(ana, body.order.id);
  });

  it("livro 57: a ordem nova vai para o fim da fila do preço, mesmo mudando só a quantidade", async () => {
    const [, bruno, carla] = buyers as [Player, Player, Player];
    const seller = sellers[0]!;
    const first = await idOf(await post(bruno, order("PAL3", "buy", 100, 4000)));
    const second = await idOf(await post(carla, order("PAL3", "buy", 50, 4000)));
    const edited = (await put(bruno, first, { quantity: 90, limitPrice: 4000 })).json().order.id as number;
    expect(edited).toBeGreaterThan(second);
    // uma venda de 50 a R$ 40,00 casa com a ordem que estava na frente: a de Carla; a de Bruno, que foi para o fim, nem é tocada
    const sale = await post(seller, order("PAL3", "sell", 50, 4000));
    expect(sale.statusCode).toBe(201);
    expect((await row(second)).status).toBe("filled");
    expect(await row(edited)).toMatchObject({ status: "open", filled: 0 });
    await del(bruno, edited);
  });

  it("livro 58: recusada (sem caixa, fora da faixa), nada muda: a antiga segue inteira, no mesmo lugar e com a mesma reserva", async () => {
    const dora = buyers[3]!;
    const id = await idOf(await post(dora, order("SPT3", "buy", 100, 4000)));
    const before = await row(id);

    const semCaixa = await put(dora, id, { quantity: 300, limitPrice: 4000 }); // R$ 12.000,00 > R$ 10.000,00
    expect(semCaixa.statusCode).toBe(422);
    expect(semCaixa.json()).toEqual({ code: "insufficient_cash", message: MARKET_ERROR_MESSAGES.insufficient_cash });
    const foraDaFaixa = await put(dora, id, { quantity: 100, limitPrice: 9000 });
    expect(foraDaFaixa.json().code).toBe("price_out_of_band");
    const invalida = await put(dora, id, { quantity: 1.5, limitPrice: 4000 });
    expect(invalida.json().code).toBe("invalid_quantity");

    const mine = await open(dora);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id, status: "open", quantity: 100, limitPrice: 4000, reservedCash: 400_000 });
    expect((await row(id)).createdAt).toEqual(before.createdAt);
    await del(dora, id);
  });

  it("livro 58: a edição de uma venda sem ações livres para a quantidade nova é recusada e a venda antiga fica", async () => {
    const seller = sellers[1]!;
    const id = await idOf(await post(seller, order("COR3", "sell", 100, 4500)));
    const res = await put(seller, id, { quantity: 600, limitPrice: 4500 }); // só tem 500
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("insufficient_shares");
    expect((await open(seller)).find((o) => o.id === id)).toMatchObject({ status: "open", quantity: 100 });
    // e uma troca que cabe passa
    const ok = await put(seller, id, { quantity: 500, limitPrice: 4500 });
    expect(ok.statusCode).toBe(200);
    await del(seller, ok.json().order.id);
  });

  it("livro 59: se o preço novo cruza o livro, a nova executa como qualquer limitada e o que sobra fica", async () => {
    const eva = buyers[4]!;
    const seller = sellers[2]!;
    expect((await post(seller, order("FLA3", "sell", 50, 4200))).statusCode).toBe(201);
    const id = await idOf(await post(eva, order("FLA3", "buy", 100, 3900)));
    const res = await put(eva, id, { quantity: 100, limitPrice: 4200 });
    expect(res.statusCode).toBe(200);
    const body = replaceOrderResponseSchema.parse(res.json());
    expect(body.trades).toHaveLength(1);
    expect(body.trades[0]).toMatchObject({ price: 4200, quantity: 50 });
    expect(body.order).toMatchObject({ filled: 50, status: "open", reservedCash: 50 * 4200 });
    await del(eva, body.order.id);
  });

  it("livro 59: ordem já cancelada ou executada dá 409 order_not_open; de outra pessoa ou inexistente, 404", async () => {
    const fabio = buyers[5]!;
    const outro = buyers[6]!;
    const id = await idOf(await post(fabio, order("FLA3", "buy", 10, 3800)));
    expect((await put(outro, id, { quantity: 10, limitPrice: 3800 })).statusCode).toBe(404);
    expect((await put(fabio, 999_999, { quantity: 10, limitPrice: 3800 })).statusCode).toBe(404);
    expect((await del(fabio, id)).statusCode).toBe(200);
    const res = await put(fabio, id, { quantity: 10, limitPrice: 3800 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("order_not_open");
  });

  it("livro 59: com 50 ordens abertas, editar uma é aceito e o total continua em 50; uma nova a mais é recusada", async () => {
    const gil = buyers[7]!;
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) ids.push(await idOf(await post(gil, order("PAL3", "buy", 1, 3600 + i))));
    expect((await post(gil, order("PAL3", "buy", 1, 3700))).json().code).toBe("too_many_open_orders");
    const res = await put(gil, ids[0]!, { quantity: 2, limitPrice: 3650 });
    expect(res.statusCode).toBe(200);
    expect(await open(gil)).toHaveLength(50);
  });

  it("livro 59: em ordem parcialmente executada, a quantidade nova é o que ela ainda quer; o executado fica", async () => {
    const hugo = buyers[2]!;
    const seller = sellers[0]!;
    const id = await idOf(await post(hugo, order("SPT3", "buy", 100, 4000)));
    expect((await post(seller, order("SPT3", "sell", 40, 4000))).statusCode).toBe(201);
    expect(await row(id)).toMatchObject({ filled: 40, status: "open" });
    const res = await put(hugo, id, { quantity: 30, limitPrice: 4000 });
    expect(res.statusCode).toBe(200);
    const body = replaceOrderResponseSchema.parse(res.json());
    expect(body.replaced).toMatchObject({ id, filled: 40, status: "cancelled" });
    expect(body.order).toMatchObject({ quantity: 30, filled: 0, reservedCash: 30 * 4000 });
    await del(hugo, body.order.id);
  });

  it("a mesma Idempotency-Key repete a resposta sem trocar de novo; com outro corpo dá idempotency_conflict", async () => {
    const ines = buyers[1]!;
    const id = await idOf(await post(ines, order("COR3", "buy", 10, 3500)));
    const key = { "idempotency-key": "troca-ines-0001-abcdefgh" };
    const a = await put(ines, id, { quantity: 20, limitPrice: 3500 }, key);
    const b = await put(ines, id, { quantity: 20, limitPrice: 3500 }, key);
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect((await open(ines)).filter((o) => o.ticker === "COR3")).toHaveLength(1);
    const c = await put(ines, id, { quantity: 21, limitPrice: 3500 }, key);
    expect(c.statusCode).toBe(409);
    expect(c.json().code).toBe("idempotency_conflict");
    await del(ines, a.json().order.id);
  });
});
