import "reflect-metadata";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { AUCTION_DURATION_MS } from "@futbolsa/engine";
import type { Database } from "../../src/infra/db/client.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { trades } from "../../src/infra/db/schema/index.js";
import { isAuctionExpired, isInAuction, type OrderService, type PlaceOrderInput, type PlaceOrderResult } from "../../src/modules/market/index.js";
import { useTestDatabase } from "../support/db.js";
import { openPlayerWallets } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  barrier,
  cancelDirect,
  clubRow,
  giveShares,
  openOrderIds,
  openTreasury,
  orderInputs,
  orderRow,
  orderService,
  positionOf,
  setTunnelState,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// L4 do Plano do livro de ofertas e formador, "Concorrentes": a abertura do leilão com ordens (e um cancelamento) ao
// mesmo tempo, cada uma na transação e na conexão dela, com barreira e 50 repetições. O cancelamento de verdade é
// da T6: aqui ele é feito direto no banco (`cancelDirect`), com as mesmas travas (o clube, depois a carteira).

const ROUNDS = 50;
/** Terça, 6 de abril de 2027, 12h40 de Brasília. */
const NOW = new Date("2027-04-06T15:40:00Z");
const RICH = 10_000_000;
/** Um clube por cenário. Todos com referência e preço exibido em R$ 40,00: túnel de R$ 36,00 a R$ 44,00. */
const TICKERS = ["FLA3", "PAL3", "SPT3"];

describe("o túnel e o leilão com ordens ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(30);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let service: OrderService;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number;
  /** Repetições do `withTransaction` por *deadlock* em todo o arquivo: tem de ficar em zero. */
  let retries = 0;
  const transaction = { onRetry: () => retries++ };

  let seller1: number, seller2: number, seller3: number, buyerA: number, buyerB: number;

  beforeAll(async () => {
    db = t.db;
    ({ seasonId, clubIds } = await marketSeason(db, { tickers: TICKERS }));
    ({ service } = orderService(db));
    o = orderInputs({ seasonId, now: NOW });
    await openTreasury(db, seasonId);
    // os vendedores nascem antes e depois dos compradores: os ids não seguem a ordem dos preços
    [seller1, buyerA, seller2, buyerB, seller3] = (await openPlayerWallets(db, seasonId, 5, RICH)) as [number, number, number, number, number];
    for (const ticker of TICKERS) {
      for (const seller of [seller1, seller2, seller3]) await giveShares(db, seller, clubIds.get(ticker)!, 1_000);
    }
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const row = (ticker: string) => clubRow(db, seasonId, club(ticker));
  const place = (input: PlaceOrderInput) => service.place(input, { transaction });
  const tradesIn = async (ticker: string) => (await db.select({ id: trades.id }).from(trades).where(eq(trades.clubId, club(ticker)))).length;

  /** Uma ordem que começa a transação, espera as outras na barreira e só então pede o clube. */
  const placeBehind = (arrive: () => Promise<void>, input: PlaceOrderInput): Promise<PlaceOrderResult> =>
    withTransaction(
      db,
      async (tx) => {
        await tx.db.execute(sql`select 1`);
        await arrive();
        const attempt = await service.placeOrder(tx, input);
        if (isAuctionExpired(attempt)) throw new Error("nenhum leilão vence neste arquivo");
        return attempt;
      },
      transaction,
    );

  /**
   * As ordens juntas, com os resultados na ordem das entradas. Quem começa primeiro costuma pegar a trava do clube
   * primeiro; `reversed` começa pela última, para as rodadas pares e ímpares cobrirem as duas ordens de chegada.
   */
  const together = async (inputs: PlaceOrderInput[], reversed: boolean): Promise<PlaceOrderResult[]> => {
    const arrive = barrier(inputs.length);
    const order = inputs.map((_, index) => index);
    if (reversed) order.reverse();
    const results: PlaceOrderResult[] = [];
    await Promise.all(
      order.map(async (index) => {
        results[index] = await placeBehind(arrive, inputs[index]!);
      }),
    );
    return results;
  };

  /**
   * Volta o clube ao começo para a rodada seguinte: cancela o que ficou no livro (devolvendo as reservas), encerra o
   * leilão sem negócio e põe o preço exibido de volta em R$ 40,00. A referência do túnel continua R$ 40,00.
   */
  const resetClub = async (ticker: string) => {
    for (const orderId of await openOrderIds(db, club(ticker))) {
      expect(await cancelDirect(db, { seasonId, ticker, orderId, at: NOW }, transaction)).toBe(true);
    }
    await setTunnelState(db, seasonId, club(ticker), { auctionOpenedAt: null, auctionUntil: null, lastPrice: 4000 });
  };

  it("1. duas ordens que abririam o leilão ao mesmo tempo: uma abre e a outra entra nele; nenhum negócio e um fim de leilão só", async () => {
    const later = new Date(NOW.getTime() + 1_000);
    const opened = { first: 0, second: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const sale = accepted(await place(o.sellLimit(seller1, "FLA3", 10, 4450)));

      // as duas alcançariam a venda a R$ 44,50, fora do túnel; uma leu o relógio 1 segundo depois da outra
      const [a, b] = (
        await together([o.buyLimit(buyerA, "FLA3", 10, 4500), o.buyLimit(buyerB, "FLA3", 10, 4500, { now: later })], round % 2 === 1)
      ).map(accepted);
      opened[a!.openedAuction ? "first" : "second"]++;

      expect([a!.trades, b!.trades]).toEqual([[], []]);
      expect([a!.openedAuction, b!.openedAuction].sort()).toEqual([false, true]);
      // o leilão dura 3 horas a partir de quem o abriu, e quem chegou depois vê o mesmo fim
      const openedAt = a!.openedAuction ? NOW : later;
      const until = new Date(openedAt.getTime() + AUCTION_DURATION_MS);
      expect([a!.auction, b!.auction]).toEqual([{ until }, { until }]);
      expect(await row("FLA3")).toMatchObject({ auctionOpenedAt: openedAt, auctionUntil: until, lastPrice: 4000, lastTradeAt: null });
      for (const r of [a!, b!]) expect(await orderRow(db, r.order.id)).toMatchObject({ status: "open", filled: 0, reservedCash: 45_000 });
      expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "open", filled: 0 });
      await resetClub("FLA3");
    }
    // as duas ordens de chegada aconteceram
    expect(opened.first).toBeGreaterThan(0);
    expect(opened.second).toBeGreaterThan(0);
    expect(await tradesIn("FLA3")).toBe(0);
    expect(retries).toBe(0);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("2. uma ordem dentro do túnel e outra fora ao mesmo tempo: a de dentro negocia antes de o leilão abrir ou entra nele sem negociar; nenhum negócio sai depois de o leilão abrir", async () => {
    const seen = { tradedBefore: 0, enteredAuction: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      accepted(await place(o.sellLimit(seller1, "PAL3", 10, 4300)));
      accepted(await place(o.sellLimit(seller2, "PAL3", 10, 4450)));
      const before = await tradesIn("PAL3");

      // a de dentro compra 10 a R$ 43,00; a de fora compraria 10 a R$ 43,00 e 10 a R$ 44,50 (ou só estas, se as
      // primeiras já saíram): nos dois casos alcança um preço fora do túnel
      const [inside, outside] = (
        await together([o.buyLimit(buyerA, "PAL3", 10, 4300), o.buyLimit(buyerB, "PAL3", 20, 4500)], round % 2 === 1)
      ).map(accepted);

      expect(outside).toMatchObject({ trades: [], openedAuction: true });
      expect(outside!.order).toMatchObject({ status: "open", filled: 0, reservedCash: 90_000 });
      if (inside!.auction === null) {
        // chegou antes: o clube ainda estava fora de leilão
        expect(inside!.trades.map((x) => [x.quantity, x.price, x.sellerWalletId, x.inAuction])).toEqual([[10, 4300, seller1, false]]);
        seen.tradedBefore++;
      } else {
        // chegou depois: a venda a R$ 43,00 está no livro, ao alcance, e mesmo assim nada casa
        expect(inside!.trades).toEqual([]);
        expect(inside!.order).toMatchObject({ status: "open", filled: 0, reservedCash: 43_000 });
        expect(inside!.auction).toEqual(outside!.auction);
        seen.enteredAuction++;
      }
      expect(await tradesIn("PAL3")).toBe(before + inside!.trades.length);
      expect(isInAuction(await row("PAL3"))).toBe(true);
      await resetClub("PAL3");
    }
    // os dois desfechos aconteceram
    expect(seen.tradedBefore).toBeGreaterThan(0);
    expect(seen.enteredAuction).toBeGreaterThan(0);
    expect(seen.tradedBefore + seen.enteredAuction).toBe(ROUNDS);
    expect(retries).toBe(0);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("3. a ordem que abriria o leilão enquanto o dono da venda que ela alcançaria cancela: ou o leilão abre e a venda é cancelada dentro dele, ou a venda sai antes e a compra fica no livro sem leilão; nunca um negócio", async () => {
    const seen = { auction: 0, noAuction: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const sale = accepted(await place(o.sellLimit(seller3, "SPT3", 10, 4450)));

      const arrive = barrier(2);
      const startBuy = () => placeBehind(arrive, o.buyLimit(buyerA, "SPT3", 10, 4500));
      const startCancel = () => cancelDirect(db, { seasonId, ticker: "SPT3", orderId: sale.order.id, at: NOW }, { ...transaction, beforeClubLock: arrive });
      // nas rodadas pares a compra começa primeiro; nas ímpares, o cancelamento
      const racing = round % 2 === 0 ? { buy: startBuy(), cancel: startCancel() } : { cancel: startCancel(), buy: startBuy() };
      const [attempt, cancelled] = await Promise.all([racing.buy, racing.cancel]);
      const buy = accepted(attempt);

      // a venda sai sempre cancelada, com as ações livres de novo, e a compra fica inteira no livro
      expect(cancelled).toBe(true);
      expect(buy.trades).toEqual([]);
      expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "cancelled", cancelReason: "player", filled: 0 });
      expect(await positionOf(db, seller3, club("SPT3"))).toEqual({ shares: 1_000, reservedShares: 0, free: 1_000 });
      expect(await orderRow(db, buy.order.id)).toMatchObject({ status: "open", filled: 0, reservedCash: 45_000 });
      expect(await walletOf(db, buyerA)).toMatchObject({ reservedCash: 45_000, openOrders: 1 });
      // o leilão só existe se a compra chegou antes do cancelamento e viu a venda
      const spt = await row("SPT3");
      expect(isInAuction(spt)).toBe(buy.openedAuction);
      expect(buy.auction).toEqual(buy.openedAuction ? { until: new Date(NOW.getTime() + AUCTION_DURATION_MS) } : null);
      seen[buy.openedAuction ? "auction" : "noAuction"]++;
      await resetClub("SPT3");
    }
    // os dois desfechos aconteceram
    expect(seen.auction).toBeGreaterThan(0);
    expect(seen.noAuction).toBeGreaterThan(0);
    expect(seen.auction + seen.noAuction).toBe(ROUNDS);
    expect(await tradesIn("SPT3")).toBe(0);
    expect(retries).toBe(0);
    await assertMarketInvariants(db, seasonId, cashBefore);
  });

  it("nenhuma repetição por deadlock em todo o arquivo, e as carteiras terminam sem nada preso", async () => {
    expect(retries).toBe(0);
    for (const wallet of [seller1, seller2, seller3, buyerA, buyerB]) {
      expect(await walletOf(db, wallet)).toMatchObject({ reservedCash: 0, openOrders: 0 });
    }
  });
});
