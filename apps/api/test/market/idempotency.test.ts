import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_ERROR_MESSAGES, placeOrderResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockClubs, withTransaction } from "../../src/infra/db/index.js";
import { idempotencyKeys, orders, seasonClubs } from "../../src/infra/db/schema/index.js";
import { AuctionCloser, CancelService, PlayerOrdersService } from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason, type MarketSeason } from "./helpers.js";
import { assertMarketInvariants, giveCash, giveShares, orderService, setTunnelState, syncTotalShares, walletOf } from "./order-helpers.js";

// T5 do Plano do livro de ofertas e formador, P4: a `Idempotency-Key` de POST /orders. A chave é gravada na mesma
// transação da ordem; a mesma chave com o mesmo corpo devolve a mesma resposta, inclusive a recusa.

const NOW = new Date("2027-04-06T18:00:00Z");
const CASH = 1_000_000;

describe("Idempotency-Key em POST /orders", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(NOW);
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let cashBefore: number;
  let ana: { account: TestAccount; wallet: number };
  let bruno: { account: TestAccount; wallet: number };
  let carla: { account: TestAccount; wallet: number };

  const player = async (cash = CASH) => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }], cash);
    return { account, wallet: wallet! };
  };
  const postOrder = async (account: TestAccount, payload: object, key?: string) =>
    app.inject({
      method: "POST",
      url: "/orders",
      payload,
      headers: { ...bearer(await account.tokenWith({ at: clock.now() })), ...(key === undefined ? {} : { "idempotency-key": key }) },
    });
  const buy = (ticker: string, quantity: number, limitPrice: number) => ({ ticker, side: "buy", type: "limit", quantity, limitPrice });
  const ordersWithKey = async (walletId: number, key: string) =>
    database.db.select().from(orders).where(and(eq(orders.walletId, walletId), eq(orders.idempotencyKey, key)));
  const keyRows = async (userId: string) => database.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.userId, userId));

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    ana = await player();
    bruno = await player();
    carla = await player(10_000); // R$ 100,00: pouco caixa, para a recusa
    await giveShares(database.db, bruno.wallet, s.clubIds.get("PAL3")!, 1_000);
    await syncTotalShares(database.db, s.seasonId);
    cashBefore = await totalCash(database.db, s.seasonId);
  });
  afterAll(async () => {
    await assertMarketInvariants(database.db, s.seasonId, cashBefore + 1_000_000);
    await app.close();
  });

  it("a mesma chave duas vezes com o mesmo corpo devolve a mesma resposta e grava uma ordem só", async () => {
    const first = await postOrder(ana.account, buy("FLA3", 10, 3900), "chave-1");
    expect(first.statusCode).toBe(201);
    const again = await postOrder(ana.account, buy("FLA3", 10, 3900), "chave-1");
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(placeOrderResponseSchema.parse(again.json()).order.id).toBe(first.json().order.id);
    expect(await ordersWithKey(ana.wallet, "chave-1")).toHaveLength(1);
    expect(await walletOf(database.db, ana.wallet)).toMatchObject({ reservedCash: 39_000, openOrders: 1 });
  });

  it("a mesma chave duas vezes ao mesmo tempo grava uma ordem só, e as duas respostas são iguais (10 repetições)", async () => {
    for (let round = 0; round < 10; round++) {
      const key = `simultanea-${round}`;
      const [a, b] = await Promise.all([postOrder(ana.account, buy("SPT3", 1, 3900), key), postOrder(ana.account, buy("SPT3", 1, 3900), key)]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(a.json()).toEqual(b.json());
      expect(await ordersWithKey(ana.wallet, key)).toHaveLength(1);
    }
    expect(await walletOf(database.db, ana.wallet)).toMatchObject({ openOrders: 11 });
  });

  it("a mesma chave com outro corpo dá idempotency_conflict, e nada novo é gravado", async () => {
    const before = await walletOf(database.db, ana.wallet);
    const res = await postOrder(ana.account, buy("FLA3", 11, 3900), "chave-1");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: "idempotency_conflict", message: MARKET_ERROR_MESSAGES.idempotency_conflict });
    expect(await walletOf(database.db, ana.wallet)).toEqual(before);
    expect(await ordersWithKey(ana.wallet, "chave-1")).toHaveLength(1);
  });

  it("a recusa repetida com a mesma chave devolve a mesma recusa, mesmo depois de o caixa mudar", async () => {
    const refused = await postOrder(carla.account, buy("FLA3", 10, 4000), "recusa-1");
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({ code: "insufficient_cash", message: MARKET_ERROR_MESSAGES.insufficient_cash });
    const [stored] = await keyRows(carla.account.id);
    expect(stored).toMatchObject({ key: "recusa-1", statusCode: 422 });

    // agora a compra caberia no caixa, mas a chave já respondeu: a mesma recusa volta
    await giveCash(database.db, carla.wallet, 1_000_000);
    const again = await postOrder(carla.account, buy("FLA3", 10, 4000), "recusa-1");
    expect(again.statusCode).toBe(422);
    expect(again.json()).toEqual(refused.json());
    expect(await walletOf(database.db, carla.wallet)).toMatchObject({ openOrders: 0, reservedCash: 0 });
    // com uma chave nova, a ordem passa
    expect((await postOrder(carla.account, buy("FLA3", 10, 4000), "recusa-2")).statusCode).toBe(201);
  });

  it("sem o cabeçalho, a ordem entra sem idempotência: duas chamadas iguais gravam duas ordens", async () => {
    const before = (await walletOf(database.db, ana.wallet)).openOrders;
    expect((await postOrder(ana.account, buy("COR3", 1, 3800))).statusCode).toBe(201);
    expect((await postOrder(ana.account, buy("COR3", 1, 3800))).statusCode).toBe(201);
    expect((await walletOf(database.db, ana.wallet)).openOrders).toBe(before + 2);
  });

  it("a chave é de cada pessoa: a mesma chave de outro jogador é outra ordem", async () => {
    const res = await postOrder(bruno.account, { ticker: "PAL3", side: "sell", type: "limit", quantity: 5, limitPrice: 4100 }, "chave-1");
    expect(res.statusCode).toBe(201);
    expect(await ordersWithKey(bruno.wallet, "chave-1")).toHaveLength(1);
  });

  it("chave vazia, longa demais ou com espaço dá 400", async () => {
    for (const key of ["", "x".repeat(201), "com espaço"]) {
      const res = await postOrder(ana.account, buy("FLA3", 1, 3900), key);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid_input");
    }
  });

  it("leilão vencido: a transação com a chave é desfeita, o leilão fecha numa transação própria e a ordem é repetida uma vez", async () => {
    const pal3 = s.clubIds.get("PAL3")!;
    // PAL3 em leilão que venceu às 17h; a tarefa do fim do leilão ainda não passou
    await setTunnelState(database.db, s.seasonId, pal3, { auctionOpenedAt: new Date("2027-04-06T14:00:00Z"), auctionUntil: new Date("2027-04-06T17:00:00Z") });
    let closes = 0;
    // o fechamento de mentira: só limpa as colunas do leilão, numa transação própria, com o clube travado
    const closer = new (class extends AuctionCloser {
      async closeAuction(seasonId: number, ticker: string): Promise<void> {
        closes++;
        await withTransaction(database.db, async (tx) => {
          await lockClubs(tx, seasonId, [ticker]);
          await tx.db.update(seasonClubs).set({ auctionOpenedAt: null, auctionUntil: null }).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, pal3)));
        });
      }
    })();
    const { service } = orderService(database.db);
    const routes = new PlayerOrdersService(database.db, clock, service, new CancelService(database.db, new PortfolioLedger()), closer);

    const r = await routes.place(ana.account.id, { ticker: "PAL3", side: "buy", type: "limit", quantity: 5, limitPrice: 4100 }, "leilao-1");
    expect(closes).toBe(1);
    // fora de leilão, a compra casa com a venda de Bruno a R$ 41,00
    expect(r.order).toMatchObject({ status: "filled", filled: 5 });
    expect(r.trades.map((t) => t.price)).toEqual([4100]);
    expect(await ordersWithKey(ana.wallet, "leilao-1")).toHaveLength(1);
    const [stored] = (await keyRows(ana.account.id)).filter((k) => k.key === "leilao-1");
    expect(stored!.statusCode).toBe(201);
    // repetir a chave devolve a resposta guardada, sem fechar nada
    expect(await routes.place(ana.account.id, { ticker: "PAL3", side: "buy", type: "limit", quantity: 5, limitPrice: 4100 }, "leilao-1")).toEqual(r);
    expect(closes).toBe(1);
    const [pending] = (await database.db.execute(sql`select count(*)::int as n from futbolsa.idempotency_keys where status_code = 0`)).rows;
    expect(Number(pending!.n)).toBe(0);
  });
});
