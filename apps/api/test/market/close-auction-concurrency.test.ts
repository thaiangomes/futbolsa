import "reflect-metadata";
import { asc, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { dayStart } from "@futbolsa/engine";
import type { Database } from "../../src/infra/db/client.js";
import { trades } from "../../src/infra/db/schema/index.js";
import {
  AuctionCloser,
  CancelService,
  CloseAuctionService,
  OrderService,
  PostgresMatchingEngine,
  type CancelOrderResult,
  type CloseAuctionResult,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { useTestDatabase } from "../support/db.js";
import { openPlayerWallets, sleep } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  barrier,
  clubRow,
  giveShares,
  openOrderIds,
  openTreasury,
  orderInputs,
  orderRow,
  positionOf,
  setTunnelState,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// L5 do Plano do livro de ofertas e formador, "Concorrentes": o fim do leilão com outra transação ao mesmo tempo, cada
// uma na conexão dela, com uma barreira para elas se cruzarem e 50 repetições, alternando quem sai primeiro: duas
// tarefas fechando o mesmo leilão; o fim do leilão e um cancelamento; o fim do leilão e uma ordem nova; dois clubes
// fechando leilão com a tesouraria nos dois. Nenhuma repetição por *deadlock* em todo o arquivo.

const ROUNDS = 50;
/** Cada rodada ganha uma janela de 4 horas: o leilão abre no começo e termina 3 horas depois. */
const START = new Date("2027-04-07T03:00:00Z");
const SLOT_MS = 4 * 3_600_000;
const HOUR = 3_600_000;
const RICH = 50_000_000;

const later = (at: Date, ms: number) => new Date(at.getTime() + ms);

describe("o fim do leilão com outras transações ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(30);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let closer: CloseAuctionService;
  let service: OrderService;
  let cancels: CancelService;
  let o: ReturnType<typeof orderInputs>;
  let treasury: number;
  let ana: number, bruno: number, carla: number;
  let cashBefore: number;
  /** Repetições do `withTransaction` por *deadlock* em todo o arquivo, inclusive nos fechamentos pela costura: tem de ficar em zero. */
  let retries = 0;
  const transaction = { onRetry: () => retries++ };
  let slot = 0;

  beforeAll(async () => {
    db = t.db;
    ({ seasonId, clubIds } = await marketSeason(db, { tickers: ["FLA3", "PAL3"] }));
    const ledger = new PortfolioLedger();
    closer = new CloseAuctionService(db, ledger);
    // o mesmo fechamento que o Nest liga (P10), contando as repetições das transações dele
    const counted = new (class extends AuctionCloser {
      async closeAuction(season: number, ticker: string, now: Date): Promise<void> {
        await closer.closeAuction(season, ticker, now, { transaction });
      }
    })();
    service = new OrderService(db, new PostgresMatchingEngine(ledger), counted);
    cancels = new CancelService(db, ledger, counted);
    o = orderInputs({ seasonId, now: START });
    // os ids não seguem a ordem dos papéis: Bruno nasce antes de Ana
    [bruno, ana, carla] = (await openPlayerWallets(db, seasonId, 3, RICH)) as [number, number, number];
    treasury = await openTreasury(db, seasonId, RICH);
    await giveShares(db, bruno, club("FLA3"), 5_000);
    await giveShares(db, ana, club("PAL3"), 1_000);
    await giveShares(db, treasury, club("FLA3"), 1_000);
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });

  const club = (ticker: string) => clubIds.get(ticker)!;

  /**
   * A janela da rodada: o clube entra em leilão no começo dela (referência e preço exibido em R$ 40,00), as ordens
   * chegam uma hora depois e o leilão termina três horas depois do começo.
   */
  const nextAuction = async (tickers: readonly string[]) => {
    const opened = new Date(START.getTime() + SLOT_MS * slot++);
    const until = later(opened, 3 * HOUR);
    for (const ticker of tickers) {
      await setTunnelState(db, seasonId, club(ticker), {
        lastPrice: 4000,
        tunnelRef: 4000,
        tunnelRefDay: new Date(dayStart(opened.getTime())),
        auctionOpenedAt: opened,
        auctionUntil: until,
      });
    }
    return { placed: { now: later(opened, HOUR) }, until };
  };

  /** Quem sai da barreira 3 ms depois: a outra costuma pegar a trava do clube primeiro, e esta espera por ela. */
  const meeting = (late: string) => {
    const together = barrier(2);
    return (who: string) => async () => {
      await together();
      if (who === late) await sleep(3);
    };
  };

  const tradesOfOrders = async (ids: number[]) => db.select().from(trades).where(inArray(trades.buyOrderId, ids)).orderBy(asc(trades.id));
  const soldBy = async (orderId: number) => (await db.select().from(trades).where(eq(trades.sellOrderId, orderId))).reduce((n, x) => n + x.quantity, 0);
  /** Tira do livro o que sobrou da rodada, depois do fim do leilão, devolvendo as reservas. */
  const clear = async (ticker: string, until: Date) => {
    for (const orderId of await openOrderIds(db, club(ticker))) {
      const row = await orderRow(db, orderId);
      expect((await cancels.cancelOrder({ walletId: row.walletId, orderId, now: later(until, 60_000) }, { transaction })).ok).toBe(true);
    }
  };

  it("duas tarefas fechando o mesmo leilão: os negócios saem uma vez só (50 repetições)", async () => {
    const won = { first: 0, second: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const { placed, until } = await nextAuction(["FLA3"]);
      const sale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 3900, placed)));
      const purchase = accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4100, placed)));
      const meet = meeting(round % 2 === 0 ? "second" : "first");

      const [first, second] = (await Promise.all([
        closer.closeAuction(seasonId, "FLA3", until, { beforeClubLock: meet("first"), transaction }),
        closer.closeAuction(seasonId, "FLA3", until, { beforeClubLock: meet("second"), transaction }),
      ])) as [CloseAuctionResult, CloseAuctionResult];

      const winners = [first, second].filter((r) => r.closed);
      expect(winners).toHaveLength(1);
      const loser = [first, second].find((r) => !r.closed)!;
      expect(loser).toMatchObject({ closed: false, reason: "not_in_auction" });
      if (first.closed) won.first++;
      else won.second++;
      // um negócio só, de 10 a R$ 39,00 (D3), e as duas ordens terminadas
      expect((await tradesOfOrders([purchase.order.id])).map((x) => [x.sellOrderId, x.quantity, x.price, x.inAuction, x.at])).toEqual([
        [sale.order.id, 10, 3900, true, until],
      ]);
      expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "filled", filled: 10 });
      expect(await orderRow(db, purchase.order.id)).toMatchObject({ status: "filled", filled: 10, reservedCash: 0 });
      expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ lastPrice: 3900, auctionOpenedAt: null, auctionUntil: null });
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
    expect(won.first).toBeGreaterThan(0);
    expect(won.second).toBeGreaterThan(0);
  }, 180_000);

  it("fim do leilão e cancelamento ao mesmo tempo: ou a venda entra no preço único, ou sai cancelada, nunca os dois; o cancelamento que chega depois do fim sempre encontra o leilão fechado (50 repetições)", async () => {
    const outcomes = { auctionFirst: 0, cancelFirst: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const { placed, until } = await nextAuction(["FLA3"]);
      const sale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 3900, placed)));
      const purchase = accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4100, placed)));
      const shares = await positionOf(db, bruno, club("FLA3"));
      const anaCash = await walletOf(db, ana);
      // a cada duas rodadas troca quem sai da barreira depois; a cada quatro, o pedido de cancelamento chega 1 ms antes
      // do fim ou 1 s depois dele
      const meet = meeting(round % 2 === 0 ? "cancel" : "close");
      const afterEnd = (round >> 1) % 2 === 1;
      const cancelAt = afterEnd ? later(until, 1_000) : later(until, -1);

      const [, cancelled] = (await Promise.all([
        closer.closeAuction(seasonId, "FLA3", until, { beforeClubLock: meet("close"), transaction }),
        cancels.cancelOrder({ walletId: bruno, orderId: sale.order.id, now: cancelAt }, { beforeClubLock: meet("cancel"), transaction }),
      ])) as [CloseAuctionResult, CancelOrderResult];

      const sold = await soldBy(sale.order.id);
      const saleNow = await orderRow(db, sale.order.id);
      expect(saleNow.filled).toBe(sold);
      if (sold > 0) {
        // o fim do leilão veio antes: a venda inteira entrou no preço único e o cancelamento não achou o que cancelar
        outcomes.auctionFirst++;
        expect(sold).toBe(10);
        expect(cancelled).toEqual({ ok: false, code: "order_not_open" });
        expect(saleNow.status).toBe("filled");
        expect(await walletOf(db, ana)).toMatchObject({ cash: anaCash.cash - 39_000, reservedCash: anaCash.reservedCash - 41_000 });
      } else {
        // o cancelamento veio antes do fim: nenhum negócio, e o leilão acabou sem ele
        outcomes.cancelFirst++;
        expect(afterEnd).toBe(false);
        expect(cancelled.ok).toBe(true);
        expect(saleNow).toMatchObject({ status: "cancelled", cancelReason: "player", filled: 0 });
        expect(await orderRow(db, purchase.order.id)).toMatchObject({ status: "open", filled: 0, reservedCash: 41_000 });
      }
      // nunca ações presas na venda cancelada nem vendidas a mais
      expect(await positionOf(db, bruno, club("FLA3"))).toEqual({ shares: shares.shares - sold, reservedShares: 0, free: shares.shares - sold });
      expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });
      await clear("FLA3", until);
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
    expect(outcomes.auctionFirst).toBeGreaterThan(0);
    expect(outcomes.cancelFirst).toBeGreaterThan(0);
  }, 180_000);

  it("fim do leilão e ordem nova ao mesmo tempo: a ordem entra no leilão (antes do fim) ou casa depois dele com a referência nova; os negócios do leilão saem uma vez e o horário nunca recua (50 repetições)", async () => {
    const outcomes = { inAuction: 0, afterAuction: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const { placed, until } = await nextAuction(["FLA3"]);
      const cheap = accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 3900, placed)));
      const dear = accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4000, placed)));
      const purchase = accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4100, placed)));
      const meet = meeting(round % 2 === 0 ? "order" : "close");
      // a cada quatro rodadas, a ordem de Carla chega 1 ms antes do fim ou 2 s depois dele (P10)
      const afterEnd = (round >> 1) % 2 === 1;
      const arrival = afterEnd ? later(until, 2_000) : later(until, -1);

      const [, placedNow] = await Promise.all([
        closer.closeAuction(seasonId, "FLA3", until, { beforeClubLock: meet("close"), transaction }),
        (async () => {
          await meet("order")();
          return service.place(o.buyLimit(carla, "FLA3", 5, 4050, { now: arrival }), { transaction });
        })(),
      ]);

      const carlas = accepted(placedNow);
      const all = await tradesOfOrders([purchase.order.id, carlas.order.id]);
      const auction = all.filter((x) => x.inAuction);
      // o leilão fechou uma vez: todos os negócios dele num preço e num horário só
      expect(new Set(auction.map((x) => `${x.price}@${x.at.toISOString()}`)).size).toBe(1);
      expect(auction.filter((x) => x.buyOrderId === purchase.order.id).map((x) => [x.sellOrderId, x.quantity])).toEqual([[cheap.order.id, 10]]);
      const carlaTrades = all.filter((x) => x.buyOrderId === carlas.order.id);
      expect(carlaTrades.map((x) => [x.sellOrderId, x.quantity, x.price])).toEqual([[dear.order.id, 5, 4000]]);
      expect(await orderRow(db, carlas.order.id)).toMatchObject({ status: "filled", filled: 5, reservedCash: 0 });
      if (carlaTrades[0]!.inAuction) {
        // a ordem chegou antes do fim e entrou no leilão: preço único de R$ 40,00 com 15 ações
        outcomes.inAuction++;
        expect(afterEnd).toBe(false);
        expect(auction.map((x) => x.price)).toEqual([4000, 4000]);
      } else {
        // o leilão fechou antes (a R$ 39,00, D3) e a ordem casou depois, dentro do túnel novo, nunca antes dele
        outcomes.afterAuction++;
        expect(auction.map((x) => x.price)).toEqual([3900]);
        expect(carlaTrades[0]).toMatchObject({ priceBefore: 3900 });
        expect(carlaTrades[0]!.at.getTime()).toBeGreaterThanOrEqual(auction[0]!.at.getTime());
      }
      const ordered = [...all].sort((a, b) => a.id - b.id).map((x) => x.at.getTime());
      expect([...ordered].sort((a, b) => a - b)).toEqual(ordered);
      expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });
      await clear("FLA3", until);
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
    expect(outcomes.inAuction).toBeGreaterThan(0);
    expect(outcomes.afterAuction).toBeGreaterThan(0);
  }, 180_000);

  it("dois clubes fechando leilão ao mesmo tempo com a tesouraria e Ana nos dois: sem deadlock, um negócio em cada (50 repetições)", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { placed, until } = await nextAuction(["FLA3", "PAL3"]);
      const house = { ...placed, actor: "house" as const };
      // FLA3: a casa vende e Ana compra; PAL3: Ana vende e a casa compra
      const flaSale = accepted(await service.place(o.sellLimit(treasury, "FLA3", 10, 3900, house)));
      const flaBuy = accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4100, placed)));
      const palSale = accepted(await service.place(o.sellLimit(ana, "PAL3", 10, 3900, placed)));
      const palBuy = accepted(await service.place(o.buyLimit(treasury, "PAL3", 10, 4100, house)));
      // as duas com o clube já travado chegam juntas à trava das carteiras
      const together = barrier(2);
      const late = round % 2 === 0 ? "PAL3" : "FLA3";
      const meet = (ticker: string) => async () => {
        await together();
        if (ticker === late) await sleep(3);
      };

      const results = await Promise.all(
        ["FLA3", "PAL3"].map((ticker) => closer.closeAuction(seasonId, ticker, until, { beforeWalletLock: meet(ticker), transaction })),
      );

      for (const r of results) expect(r).toMatchObject({ closed: true, price: 3900, volume: 10 });
      const done = await tradesOfOrders([flaBuy.order.id, palBuy.order.id]);
      expect(done.map((x) => [x.sellOrderId, x.withHouse, x.inAuction])).toEqual(
        expect.arrayContaining([
          [flaSale.order.id, true, true],
          [palSale.order.id, true, true],
        ]),
      );
      expect(done).toHaveLength(2);
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
  }, 180_000);
});
