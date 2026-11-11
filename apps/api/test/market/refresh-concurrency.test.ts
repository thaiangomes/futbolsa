import "reflect-metadata";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { dayStart, type Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { orders } from "../../src/infra/db/schema/index.js";
import {
  AuctionCloser,
  CancelService,
  CloseAuctionService,
  OrderService,
  PostgresMatchingEngine,
  RefreshService,
  type ClubRefreshed,
  type PlaceOrderResult,
  type RefreshResult,
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
  giveShares,
  openTreasury,
  orderInputs,
  orderRow,
  setTunnelState,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// T10 do Plano do livro de ofertas e formador, "Concorrentes": a reposição da casa com outra transação ao mesmo
// tempo, cada uma na conexão dela, com uma barreira para elas se cruzarem e 50 repetições, alternando quem sai
// primeiro: a reposição durante um negócio de Ana com a venda da casa; a reposição de dois clubes ao mesmo tempo (as
// duas travam a tesouraria); a reposição de um clube durante um negócio da casa noutro clube. Nenhuma repetição por
// *deadlock* em todo o arquivo.

const ROUNDS = 50;
/** Cada rodada ganha uma janela de 5 minutos, todas no mesmo dia de Brasília (a referência do túnel não vira). */
const START = new Date("2027-04-07T10:00:00-03:00");
const SLOT_MS = 5 * 60_000;
const MINUTE = 60_000;
const RICH = 50_000_000;

const later = (at: Date, ms: number) => new Date(at.getTime() + ms);

function refreshed(result: RefreshResult): ClubRefreshed {
  if (!result.refreshed) throw new Error(`a reposição devia cotar e não cotou: ${result.reason}`);
  return result;
}

describe("a reposição da casa com outras transações ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(30);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let service: OrderService;
  let refresher: RefreshService;
  let o: ReturnType<typeof orderInputs>;
  let treasury: number;
  let ana: number, bruno: number;
  let cashBefore: number;
  /** Repetições do `withTransaction` por *deadlock* em todo o arquivo: tem de ficar em zero. */
  let retries = 0;
  const transaction = { onRetry: () => retries++ };
  let slot = 0;

  beforeAll(async () => {
    db = t.db;
    ({ seasonId, clubIds } = await marketSeason(db, { tickers: ["FLA3", "PAL3"] }));
    const ledger = new PortfolioLedger();
    const closer = new CloseAuctionService(db, ledger);
    const counted = new (class extends AuctionCloser {
      async closeAuction(season: number, ticker: string, now: Date): Promise<void> {
        await closer.closeAuction(season, ticker, now, { transaction });
      }
    })();
    service = new OrderService(db, new PostgresMatchingEngine(ledger), counted);
    const cancels = new CancelService(db, ledger, counted);
    const noFairValue = { compute: async (): Promise<Map<string, Cents>> => new Map() };
    refresher = new RefreshService(db, service, cancels, noFairValue, new FixedClock(START), counted);
    o = orderInputs({ seasonId, now: START });
    // os ids não seguem a ordem dos papéis: Bruno nasce antes de Ana
    [bruno, ana] = (await openPlayerWallets(db, seasonId, 2, RICH)) as [number, number];
    treasury = await openTreasury(db, seasonId, RICH);
    for (const ticker of ["FLA3", "PAL3"]) {
      await giveShares(db, treasury, club(ticker), 2_000);
      await giveShares(db, bruno, club(ticker), 1_000);
      // preço exibido e referência do túnel em R$ 42,00 o dia todo: o túnel vai de R$ 37,80 a R$ 46,20
      await setTunnelState(db, seasonId, club(ticker), { lastPrice: 4200, tunnelRef: 4200, tunnelRefDay: new Date(dayStart(START.getTime())) });
    }
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const nextSlot = () => new Date(START.getTime() + SLOT_MS * slot++);
  const fair = (ticker: string, value: Cents) => new Map([[ticker, value]]);

  /** Quem sai da barreira 3 ms depois: a outra costuma pegar a trava primeiro, e esta espera por ela. */
  const meeting = (late: string) => {
    const together = barrier(2);
    return (who: string) => async () => {
      await together();
      if (who === late) await sleep(3);
    };
  };

  /** As ordens abertas da casa no clube. */
  const houseOrders = async (ticker: string) =>
    db
      .select({ id: orders.id, side: orders.side, price: orders.limitPrice, quantity: orders.quantity, filled: orders.filled })
      .from(orders)
      .where(and(eq(orders.walletId, treasury), eq(orders.clubId, club(ticker)), eq(orders.status, "open")))
      .orderBy(asc(orders.id));

  /** Nunca duas cotações da casa no mesmo lado, e o caixa reservado da tesouraria é o das compras dela que estão abertas. */
  const assertOneQuotePerSide = async () => {
    let reserved = 0;
    for (const ticker of ["FLA3", "PAL3"]) {
      const open = await houseOrders(ticker);
      expect(open.filter((x) => x.side === "buy").length).toBeLessThanOrEqual(1);
      expect(open.filter((x) => x.side === "sell").length).toBeLessThanOrEqual(1);
      for (const x of open) if (x.side === "buy") reserved += (x.quantity - x.filled) * x.price!;
    }
    expect((await walletOf(db, treasury)).reservedCash).toBe(reserved);
  };

  it("reposição durante um negócio: Ana leva a venda velha e a casa põe a nova sobre o estoque que sobrou, ou a reposição vem antes e Ana leva a nova (50 repetições)", async () => {
    const outcomes = { anaFirst: 0, refreshFirst: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const at = nextSlot();
      // o valor justo alterna entre R$ 42,00 e R$ 42,20: a venda velha e a nova têm preços diferentes (R$ 44,10 e R$ 44,31)
      const [oldFair, newFair] = round % 2 === 0 ? [4200, 4220] : [4220, 4200];
      const before = refreshed(await refresher.refreshClub(seasonId, "FLA3", at, { fairValues: fair("FLA3", oldFair), transaction }));
      const oldAsk = before.ask!.order;
      const oldBid = before.bid!.order;
      const treasuryCash = (await walletOf(db, treasury)).cash;
      const meet = meeting(round % 2 === 0 ? "ana" : "refresh");
      const when = later(at, MINUTE);

      const [result, purchase] = (await Promise.all([
        refresher.refreshClub(seasonId, "FLA3", when, { fairValues: fair("FLA3", newFair), beforeClubLock: meet("refresh"), transaction }),
        (async () => {
          await meet("ana")();
          return service.place(o.buyLimit(ana, "FLA3", 10, 4600, { now: when }), { transaction });
        })(),
      ])) as [RefreshResult, PlaceOrderResult];

      const r = refreshed(result);
      const bought = accepted(purchase);
      expect(bought.order).toMatchObject({ status: "filled", filled: 10 });
      expect(bought.trades).toHaveLength(1);
      const trade = bought.trades[0]!;
      expect(trade).toMatchObject({ quantity: 10, withHouse: true, sellerWalletId: treasury });
      if (trade.sellOrderId === oldAsk.id) {
        // Ana veio antes: levou a venda velha inteira; a reposição cancelou só a compra velha e pôs a venda nova
        outcomes.anaFirst++;
        expect(trade.price).toBe(oldAsk.limitPrice);
        expect(r.cancelled.map((c) => c.id)).toEqual([oldBid.id]);
        expect(r.ask!.order).toMatchObject({ status: "open", quantity: 10, filled: 0 });
        expect(r.ask!.order.limitPrice).not.toBe(oldAsk.limitPrice);
      } else {
        // a reposição veio antes: cancelou as duas velhas, e Ana levou a venda nova
        outcomes.refreshFirst++;
        expect(trade.sellOrderId).toBe(r.ask!.order.id);
        expect(trade.price).toBe(r.ask!.order.limitPrice);
        expect(r.cancelled.map((c) => c.id).sort((a, b) => a - b)).toEqual([oldBid.id, oldAsk.id].sort((a, b) => a - b));
        expect(await orderRow(db, r.ask!.order.id)).toMatchObject({ status: "filled", filled: 10 });
      }
      // a cotação velha nunca fica no livro, e o caixa da tesouraria só muda pela venda de Ana
      for (const id of [oldAsk.id, oldBid.id]) expect((await orderRow(db, id)).status).not.toBe("open");
      expect((await walletOf(db, treasury)).cash).toBe(treasuryCash + trade.price * 10);
      await assertOneQuotePerSide();
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
    expect(outcomes.anaFirst).toBeGreaterThan(0);
    expect(outcomes.refreshFirst).toBeGreaterThan(0);
  }, 240_000);

  it("reposição de dois clubes ao mesmo tempo, as duas travando Bruno e a tesouraria: sem deadlock, cada compra nova da casa leva a venda de Bruno (50 repetições)", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const at = nextSlot();
      const sales: Record<string, number> = {};
      for (const ticker of ["FLA3", "PAL3"]) {
        // a compra velha da casa a R$ 38,00 (valor justo de R$ 40,00), abaixo da venda que Bruno põe a R$ 39,00
        refreshed(await refresher.refreshClub(seasonId, ticker, at, { fairValues: fair(ticker, 4000), transaction }));
        sales[ticker] = accepted(await service.place(o.sellLimit(bruno, ticker, 1, 3900, { now: later(at, 1_000) }), { transaction })).order.id;
      }
      // as duas, com o clube travado, chegam juntas à trava das carteiras; a cada rodada troca quem chega depois
      const meet = meeting(round % 2 === 0 ? "PAL3" : "FLA3");

      const results = await Promise.all(
        ["FLA3", "PAL3"].map((ticker) =>
          refresher.refreshClub(seasonId, ticker, later(at, MINUTE), { fairValues: fair(ticker, 4200), beforeWalletLock: meet(ticker), transaction }),
        ),
      );

      for (const [i, ticker] of ["FLA3", "PAL3"].entries()) {
        const r = refreshed(results[i]!);
        // a compra nova a R$ 39,90 cruza a venda de Bruno e executa pelo preço dele (P2)
        expect(r.trades.map((x) => [x.sellOrderId, x.price, x.quantity, x.withHouse])).toEqual([[sales[ticker], 3900, 1, true]]);
        expect(r.bid!.order).toMatchObject({ status: "open", filled: 1, limitPrice: 3990 });
      }
      await assertOneQuotePerSide();
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
  }, 240_000);

  it("reposição do FLA3 enquanto Ana compra a venda da casa no PAL3: as duas travam a tesouraria, sem deadlock (50 repetições)", async () => {
    const outcomes = { anaFirst: 0, refreshFirst: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const at = nextSlot();
      const pal = refreshed(await refresher.refreshClub(seasonId, "PAL3", at, { fairValues: fair("PAL3", 4200), transaction }));
      const meet = meeting(round % 2 === 0 ? "ana" : "refresh");
      const when = later(at, MINUTE);

      const [result, purchase] = (await Promise.all([
        refresher.refreshClub(seasonId, "FLA3", when, { fairValues: fair("FLA3", 4200), beforeWalletLock: meet("refresh"), transaction }),
        service.place(o.buyLimit(ana, "PAL3", 2, 4600, { now: when }), { hooks: { afterReadBeforeLock: meet("ana") }, transaction }),
      ])) as [RefreshResult, PlaceOrderResult];

      const r = refreshed(result);
      const bought = accepted(purchase);
      expect(bought.trades.map((x) => [x.sellOrderId, x.price, x.quantity, x.withHouse])).toEqual([[pal.ask!.order.id, 4410, 2, true]]);
      expect(r.trades).toEqual([]);
      expect(r.cancelled.map((c) => c.side)).toEqual(["buy", "sell"]);
      // as ordens nascem depois da trava da tesouraria: o id diz quem a pegou primeiro, e a outra esperou
      if (bought.order.id < r.bid!.order.id) outcomes.anaFirst++;
      else outcomes.refreshFirst++;
      await assertOneQuotePerSide();
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
    expect(outcomes.anaFirst).toBeGreaterThan(0);
    expect(outcomes.refreshFirst).toBeGreaterThan(0);
  }, 240_000);
});
