import "reflect-metadata";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/infra/db/client.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { orders, trades } from "../../src/infra/db/schema/index.js";
import type { OrderService, PlaceOrderInput, PlaceOrderResult } from "../../src/modules/market/index.js";
import { useTestDatabase } from "../support/db.js";
import { deferred, openPlayerWallets, rng } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  giveCash,
  giveShares,
  openPlayer,
  openTreasury,
  orderInputs,
  orderRow,
  orderService,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// T4 do Plano do livro de ofertas e formador, "Concorrentes": ordens ao mesmo tempo, cada uma na transação e na
// conexão dela, com uma barreira para elas se cruzarem. Cada cenário repete 50 vezes.

const ROUNDS = 50;
const NOW = new Date("2027-04-06T13:05:00Z");
const RICH = 10_000_000;
/** Cada cenário usa clubes só dele, para o livro que um deixa não entrar no casamento do outro. */
const TICKERS = ["FLA3", "PAL3", "SPT3", "COR3", "CAM3", "BAH3", "FOR3", "GRE3", "INT3", "CRU3", "VAS3", "BOT3", "FLU3"];
const STRESS_TICKERS = ["VAS3", "BOT3", "FLU3"];

/**
 * Uma barreira para `n` transações: cada uma chama e espera; quando a última chega, todas seguem juntas. Se alguma
 * não chegar, o teste falha em vez de ficar parado.
 */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  const gate = deferred();
  return async () => {
    if (++arrived >= n) gate.resolve();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, fail) => {
      timer = setTimeout(() => fail(new Error(`a barreira esperava ${n} transações e só ${arrived} chegaram`)), 10_000);
    });
    try {
      await Promise.race([gate.promise, late]);
    } finally {
      clearTimeout(timer);
    }
  };
}

describe("ordens ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(30);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let service: OrderService;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number;
  /** Repetições do `withTransaction` por *deadlock* em todo o arquivo: tem de ficar em zero. */
  let retries = 0;
  const transaction = { onRetry: () => retries++ };

  // as carteiras de cada cenário, todas abertas antes do primeiro teste (o caixa total fica fixo dali em diante)
  let seller1: number, buyerA: number, buyerB: number;
  let buyer2: number, seller2: number;
  let anas3: number[];
  let ana4: number, bruno4: number;
  let anasLow: number[], anasHigh: number[];
  let farSeller: number, midSeller: number, nearSeller: number, carla5: number, sweeper: number;
  let crowd: number[];

  beforeAll(async () => {
    db = t.db;
    ({ seasonId, clubIds } = await marketSeason(db, { tickers: TICKERS }));
    ({ service } = orderService(db));
    o = orderInputs({ seasonId, now: NOW });
    const club = (ticker: string) => clubIds.get(ticker)!;
    /** `count` jogadores com R$ 100.000,00, como uma tupla (para desmontar sem `undefined`). */
    const players = async <T extends number[]>(count: T["length"]) => (await openPlayerWallets(db, seasonId, count, RICH)) as T;
    const shares = async (wallets: number[], ticker: string, quantity: number) => {
      for (const w of wallets) await giveShares(db, w, club(ticker), quantity);
    };

    // a tesouraria nasce primeiro (o menor id) e é sempre a última a ser travada
    treasury = await openTreasury(db, seasonId, 5_000_000);
    await shares([treasury], "VAS3", 500);
    await shares([treasury], "BOT3", 500);
    await shares([treasury], "FLU3", 500);

    // cenário 5: metade das Anas com id menor que os vendedores e metade com id maior; e o vendedor do preço mais
    // longe tem o id MENOR que o do preço mais perto (a trava fora de ordem que a P1 evita)
    anasLow = await openPlayerWallets(db, seasonId, 26, 100_000);
    [farSeller, midSeller, nearSeller] = await players(3);
    anasHigh = await openPlayerWallets(db, seasonId, 26, 100_000);
    await shares([farSeller, midSeller, nearSeller], "GRE3", 1_000);
    [carla5, sweeper] = await players(2);

    [seller1, buyerA, buyerB] = await players(3);
    await shares([seller1], "SPT3", 2_000);
    [buyer2, seller2] = await players(2);
    await shares([seller2], "COR3", 1_000);
    anas3 = await openPlayerWallets(db, seasonId, ROUNDS, 100_000);
    [ana4, bruno4] = await players(2);
    await shares([bruno4], "BAH3", 100);
    await shares([bruno4], "FOR3", 100);
    crowd = await openPlayerWallets(db, seasonId, 12, RICH);
    for (const ticker of STRESS_TICKERS) await shares(crowd, ticker, 200);

    // as Anas do cenário 5 em que o caixa SOBE no meio (rodadas ímpares) começam com R$ 400,00 e 15 CRU3 para vender
    for (const group of [anasLow, anasHigh]) {
      for (const [i, ana] of group.entries()) {
        if (i % 2 === 0) continue;
        await withdraw(ana, 60_000);
        await giveShares(db, ana, club("CRU3"), 15);
      }
    }

    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });

  /** Tira caixa de uma carteira (ajuste do admin), para a montagem. */
  const withdraw = (walletId: number, amount: number) => giveCash(db, walletId, -amount);

  /** Uma ordem na transação dela, contando as repetições por *deadlock*. */
  const place = (input: PlaceOrderInput, hooks?: { afterReadBeforeLock?: () => Promise<void> }) => service.place(input, { hooks, transaction });

  /**
   * Ordens ao mesmo tempo: cada transação começa, espera as outras na barreira e só então manda a ordem. Serve às
   * ordens do mesmo clube, que disputam a trava dele.
   */
  const together = (inputs: PlaceOrderInput[]): Promise<PlaceOrderResult[]> => {
    const arrive = barrier(inputs.length);
    return Promise.all(
      inputs.map((input) =>
        withTransaction(
          db,
          async (tx) => {
            await tx.db.execute(sql`select 1`);
            await arrive();
            return service.placeOrder(tx, input);
          },
          transaction,
        ),
      ),
    );
  };

  /**
   * Ordens da mesma carteira em clubes diferentes: as duas param **depois de ler a carteira sem trava e antes de
   * travá-la**, e seguem juntas. Uma trava a carteira primeiro e grava; a outra só percebe na releitura.
   */
  const crossing = (inputs: PlaceOrderInput[]): Promise<PlaceOrderResult[]> => {
    const arrive = barrier(inputs.length);
    return Promise.all(inputs.map((input) => place(input, { afterReadBeforeLock: arrive })));
  };

  const openOrdersIn = async (ticker: string) =>
    (await db.select({ id: orders.id }).from(orders).where(and(eq(orders.clubId, clubIds.get(ticker)!), eq(orders.status, "open")))).length;
  const tradesIn = async (ticker: string) => (await db.select({ id: trades.id }).from(trades).where(eq(trades.clubId, clubIds.get(ticker)!))).length;
  const outcome = (r: PlaceOrderResult) => (r.ok ? "ok" : r.code);

  it("1. duas compras disputando as últimas 10 ações de uma venda: uma leva as 10 e a outra fica no livro (limitada) ou é cancelada (a mercado); nunca 20 vendidas", async () => {
    const kinds = [
      ["limit", "limit"],
      ["market", "market"],
      ["limit", "market"],
      ["market", "limit"],
    ] as const;
    for (let round = 0; round < ROUNDS; round++) {
      const sale = accepted(await place(o.sellLimit(seller1, "SPT3", 10, 4000)));
      const before = await tradesIn("SPT3");
      const [kindA, kindB] = kinds[round % kinds.length]!;
      const order = (wallet: number, kind: "limit" | "market") => (kind === "limit" ? o.buyLimit(wallet, "SPT3", 10, 4000) : o.buyMarket(wallet, "SPT3", 10));

      const results = (await together([order(buyerA, kindA), order(buyerB, kindB)])).map(accepted);

      // um negócio só, de 10 ações: a venda não é vendida duas vezes
      expect(results.flatMap((r) => r.trades).map((x) => [x.quantity, x.price, x.sellerWalletId])).toEqual([[10, 4000, seller1]]);
      expect(await tradesIn("SPT3")).toBe(before + 1);
      expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "filled", filled: 10 });
      const winner = results.find((r) => r.trades.length === 1)!;
      const loser = results.find((r) => r.trades.length === 0)!;
      expect(winner.order).toMatchObject({ status: "filled", filled: 10 });
      if (loser.order.type === "limit") {
        expect(loser.order).toMatchObject({ status: "open", filled: 0, reservedCash: 40_000 });
        // a que ficou no livro executa na venda seguinte, e o livro volta a ficar vazio para a próxima rodada
        expect(accepted(await place(o.sellMarket(seller1, "SPT3", 10))).trades).toHaveLength(1);
      } else {
        expect(loser.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", filled: 0 });
      }
      expect(await openOrdersIn("SPT3")).toBe(0);
    }
    expect(retries).toBe(0);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("2. uma compra e uma venda que se cruzam chegando juntas: sai um negócio só e o livro termina sem cruzar", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const before = await tradesIn("COR3");
      // nas rodadas ímpares a compra paga até R$ 40,10: o negócio sai pelo preço de quem chegou antes ao livro
      const bid = round % 2 === 0 ? 4000 : 4010;

      const [buy, sell] = (await together([o.buyLimit(buyer2, "COR3", 10, bid), o.sellLimit(seller2, "COR3", 10, 4000)])).map(accepted);

      const done = [...buy!.trades, ...sell!.trades];
      expect(done).toHaveLength(1);
      expect(done[0]).toMatchObject({ quantity: 10, buyerWalletId: buyer2, sellerWalletId: seller2, buyOrderId: buy!.order.id, sellOrderId: sell!.order.id });
      // quem chegou depois é quem fez o negócio, pelo preço da ordem que já estava no livro
      expect(done[0]!.price).toBe(sell!.trades.length === 1 ? bid : 4000);
      expect(await tradesIn("COR3")).toBe(before + 1);
      expect(await orderRow(db, buy!.order.id)).toMatchObject({ status: "filled", filled: 10, reservedCash: 0 });
      expect(await orderRow(db, sell!.order.id)).toMatchObject({ status: "filled", filled: 10 });
      expect(await openOrdersIn("COR3")).toBe(0);
    }
    expect(await walletOf(db, buyer2)).toMatchObject({ reservedCash: 0, openOrders: 0 });
    expect(retries).toBe(0);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("3. a mesma carteira em dois clubes: Ana com R$ 1.000,00 manda compras de R$ 800,00 em FLA3 e PAL3 ao mesmo tempo; uma é aceita e a outra dá insufficient_cash", async () => {
    for (const ana of anas3) {
      const results = await crossing([o.buyLimit(ana, "FLA3", 20, 4000), o.buyLimit(ana, "PAL3", 20, 4000)]);

      // as duas leram R$ 1.000,00 livres antes de travar a carteira: a recusa só pode ter saído da releitura
      expect(results.map(outcome).sort()).toEqual(["insufficient_cash", "ok"]);
      expect(await walletOf(db, ana)).toEqual({ cash: 100_000, reservedCash: 80_000, free: 20_000, openOrders: 1 });
    }
    // uma ordem por rodada ficou no livro, num clube ou no outro
    expect((await openOrdersIn("FLA3")) + (await openOrdersIn("PAL3"))).toBe(ROUNDS);
    expect(retries).toBe(0);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("4. Ana com 49 ordens abertas manda duas em clubes diferentes ao mesmo tempo: uma passa e a outra dá too_many_open_orders", async () => {
    for (let i = 0; i < 49; i++) accepted(await place(o.buyLimit(ana4, "CAM3", 1, 3200 + i)));
    for (let round = 0; round < ROUNDS; round++) {
      const results = await crossing([o.buyLimit(ana4, "BAH3", 1, 4000), o.buyLimit(ana4, "FOR3", 1, 4000)]);

      expect(results.map(outcome).sort()).toEqual(["ok", "too_many_open_orders"]);
      expect(await walletOf(db, ana4)).toMatchObject({ openOrders: 50 });
      // Bruno executa a ordem que entrou: Ana volta a 49 abertas para a rodada seguinte
      const entered = results[0]!.ok ? "BAH3" : "FOR3";
      expect(accepted(await place(o.sellMarket(bruno4, entered, 1))).trades).toHaveLength(1);
      expect(await walletOf(db, ana4)).toMatchObject({ openOrders: 49 });
    }
    expect(retries).toBe(0);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("5. compra a mercado cujo caixa muda entre a leitura e a trava: o segundo casamento vai até onde o caixa de agora paga, e nenhuma trava sai fora da ordem", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const group = round % 4 < 2 ? anasLow : anasHigh;
      const ana = group[Math.floor(round / 4) * 2 + (round % 2)]!;
      // o livro do GRE3: 10 a R$ 40,00 (o vendedor de MAIOR id), 10 a R$ 40,10 e 10 a R$ 40,20 (o de menor id)
      accepted(await place(o.sellLimit(nearSeller, "GRE3", 10, 4000)));
      accepted(await place(o.sellLimit(midSeller, "GRE3", 10, 4010)));
      accepted(await place(o.sellLimit(farSeller, "GRE3", 10, 4020)));

      if (round % 2 === 0) {
        // O caixa CAI: Ana lê R$ 1.000,00 livres (dariam 24 ações, até o terceiro vendedor); antes de ela travar
        // a carteira, outra ordem dela reserva R$ 600,00 no INT3. Sobram R$ 400,00: só as 10 do primeiro.
        const r = accepted(
          await place(o.buyMarket(ana, "GRE3", 30), {
            afterReadBeforeLock: async () => {
              accepted(await place(o.buyLimit(ana, "INT3", 15, 4000)));
            },
          }),
        );
        expect(r.trades.map((x) => [x.sellerWalletId, x.quantity, x.price])).toEqual([[nearSeller, 10, 4000]]);
        expect(r.order).toMatchObject({ filled: 10, status: "cancelled", cancelReason: "market_remainder" });
        expect(await walletOf(db, ana)).toEqual({ cash: 60_000, reservedCash: 60_000, free: 0, openOrders: 1 });
      } else {
        // O caixa SOBE: Ana lê R$ 400,00 livres (dariam só as 10 do primeiro); antes de ela travar a carteira, a
        // venda dela de 15 CRU3 executa e entram R$ 600,00. O casamento de verdade chega ao segundo e ao terceiro
        // vendedores, de id menor que o primeiro: só não é trava fora da ordem porque os três já estavam na
        // lista travada de uma vez (P1).
        accepted(await place(o.sellLimit(ana, "CRU3", 15, 4000)));
        const r = accepted(
          await place(o.buyMarket(ana, "GRE3", 30), {
            afterReadBeforeLock: async () => {
              expect(accepted(await place(o.buyMarket(carla5, "CRU3", 15))).trades).toHaveLength(1);
            },
          }),
        );
        expect(r.trades.map((x) => [x.sellerWalletId, x.quantity, x.price])).toEqual([
          [nearSeller, 10, 4000],
          [midSeller, 10, 4010],
          [farSeller, 4, 4020],
        ]);
        expect(await walletOf(db, ana)).toEqual({ cash: 3_820, reservedCash: 0, free: 3_820, openOrders: 0 });
      }
      // limpa o que sobrou das três vendas para a rodada seguinte
      accepted(await place(o.buyMarket(sweeper, "GRE3", 100)));
      expect(await openOrdersIn("GRE3")).toBe(0);
    }
    expect(farSeller).toBeLessThan(nearSeller);
    expect(retries).toBe(0);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("6. 300 ordens sorteadas de 12 carteiras e da casa em 3 clubes, todas de uma vez: nenhuma repetição por deadlock, nenhuma trava fora da ordem e as invariantes no fim", async () => {
    const random = rng(2027);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const inputs: PlaceOrderInput[] = [];
    for (let i = 0; i < 300; i++) {
      const house = random() < 0.12;
      const wallet = house ? treasury : pick(crowd);
      const make = pick([o.buyLimit, o.sellLimit, o.buyLimit, o.sellLimit, o.buyMarket, o.sellMarket]);
      // em volta de R$ 40,00, para as ordens se cruzarem; a casa cota mais longe e não é recusada pela faixa
      const limit = 3950 + Math.floor(random() * 11) * 10 + (house ? pick([-900, 0, 900]) : 0);
      inputs.push(make(wallet, pick(STRESS_TICKERS), 1 + Math.floor(random() * 20), limit, house ? { actor: "house" } : {}));
    }
    const before = (await Promise.all(STRESS_TICKERS.map(tradesIn))).reduce((a, b) => a + b, 0);

    // qualquer erro que não seja recusa de regra (LockOrderError, LedgerError, deadlock esgotado) derruba o teste
    const results = await Promise.all(inputs.map((input) => place(input)));

    expect(retries).toBe(0);
    const made = results.filter((r) => r.ok).flatMap((r) => (r.ok ? r.trades : []));
    expect(made.length).toBeGreaterThan(50);
    expect(made.some((x) => x.withHouse)).toBe(true);
    expect((await Promise.all(STRESS_TICKERS.map(tradesIn))).reduce((a, b) => a + b, 0)).toBe(before + made.length);
    // as recusas são só as da especificação
    const refused = new Set(results.filter((r) => !r.ok).map(outcome));
    for (const code of refused) expect(["price_out_of_band", "insufficient_cash", "insufficient_shares", "self_trade", "too_many_open_orders"]).toContain(code);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("nenhuma repetição por deadlock em todo o arquivo", () => {
    expect(retries).toBe(0);
  });
});
