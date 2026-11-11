import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, gt } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayStart, type Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { orders, seasons, trades } from "../../src/infra/db/schema/index.js";
import { EventBus } from "../../src/infra/realtime/index.js";
import {
  BookPublisher,
  CancelService,
  CloseAuctionAdapter,
  CloseAuctionService,
  EndTradingService,
  OrderService,
  PostgresMatchingEngine,
  RefreshService,
  type CloseAuctionResult,
  type EndTradingResult,
  type PlaceOrderResult,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createTestApp } from "../support/app.js";
import { useTestDatabase } from "../support/db.js";
import { deferred, openPlayerWallets } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { insertMatch, marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  clubRow,
  giveShares,
  openPlayer,
  openTreasury,
  orderInputs,
  orderRow,
  positionOf,
  rejected,
  rolledBack,
  rowCounts,
  setTunnelState,
  syncTotalShares,
  waitForBlocked,
  walletOf,
} from "./order-helpers.js";

// T14 e L7 do Plano do livro de ofertas e formador: o fim da negociação (`endTrading`, Livro de ofertas e formador de
// mercado, critério 33) e o leilão aberto que acaba sem negócio. No fim do arquivo, o fim da negociação com ordens e
// com o fim do leilão ao mesmo tempo (50 repetições cada) e a medição com alguns milhares de ordens abertas.

const brt = (day: string, time: string) => new Date(`${day}T${time}:00-03:00`);
const later = (at: Date, ms: number) => new Date(at.getTime() + ms);
const HOUR = 3_600_000;
const TICKERS = ["FLA3", "PAL3", "SPT3"];
const RICH = 10_000_000;
const FAIR = new Map<string, Cents>(TICKERS.map((t) => [t, 4200]));
const noFairValue = { compute: async (): Promise<Map<string, Cents>> => new Map() };
const SERIE_A_END = brt("2027-12-05", "18:00");
const CUP_FINAL = brt("2027-12-19", "18:00");
const RECOMPRA = brt("2027-12-19", "21:00");

/** Monta os serviços do mercado como o Nest, sobre o banco dado. */
function marketServices(db: Database, clock: FixedClock) {
  const ledger = new PortfolioLedger();
  const closer = new CloseAuctionService(db, ledger);
  const adapter = new CloseAuctionAdapter(closer);
  const service = new OrderService(db, new PostgresMatchingEngine(ledger), adapter);
  const cancels = new CancelService(db, ledger, adapter);
  const refresher = new RefreshService(db, service, cancels, noFairValue, clock, adapter);
  return { closer, service, cancels, refresher, ending: new EndTradingService(cancels) };
}

describe("o fim da negociação", () => {
  const t = useTestDatabase(5);
  const clock = new FixedClock(SERIE_A_END);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let m: ReturnType<typeof marketServices>;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      clock.set(SERIE_A_END);
      treasury = await openTreasury(db, seasonId, RICH);
      m = marketServices(db, clock);
      o = orderInputs({ seasonId, now: SERIE_A_END });
      await body();
      await assertMarketInvariants(db, seasonId, cashBefore);
    });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const ready = async () => {
    for (const ticker of TICKERS) {
      await giveShares(db, treasury, club(ticker), 600);
      await setTunnelState(db, seasonId, club(ticker), { lastPrice: 4000, tunnelRef: 4000, tunnelRefDay: new Date(dayStart(SERIE_A_END.getTime())) });
    }
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  };
  const end = (at: Date) => withTransaction(db, (tx) => m.ending.endTrading(tx, at));
  const openOf = (walletId: number) =>
    db.select().from(orders).where(and(eq(orders.walletId, walletId), eq(orders.status, "open"))).orderBy(asc(orders.id));
  const season = async () => (await db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!;

  it(
    "livro 33: com a Série A fechada em 2027-12-05 tudo continua; em 2027-12-19, endTrading cancela a compra de FLA3 e a venda de PAL3 de Ana com as reservas devolvidas, a casa para em todos os clubes e ordens novas dão market_closed",
    scene(async () => {
      const ana = await openPlayer(db, seasonId, RICH);
      await giveShares(db, ana, club("PAL3"), 100);
      const bruno = await openPlayer(db, seasonId, RICH);
      await giveShares(db, bruno, club("SPT3"), 100);
      await ready();
      // a última rodada da Série A termina em 2027-12-05
      await insertMatch(db, { seasonId, homeClubId: club("FLA3"), awayClubId: club("PAL3"), kickoff: brt("2027-12-05", "16:00"), status: "finished", round: 38 });
      for (const ticker of TICKERS) expect((await m.refresher.refreshClub(seasonId, ticker, SERIE_A_END, { fairValues: FAIR })).refreshed).toBe(true);
      const buy = accepted(await m.service.place(o.buyLimit(ana, "FLA3", 10, 3900)));
      const sale = accepted(await m.service.place(o.sellLimit(ana, "PAL3", 10, 4300)));
      expect(await walletOf(db, ana)).toMatchObject({ reservedCash: 39_000, openOrders: 2 });
      expect(await positionOf(db, ana, club("PAL3"))).toMatchObject({ reservedShares: 10 });

      // depois da Série A, tudo continua: a casa repõe, as ordens valem e ordens novas entram
      const afterSerieA = brt("2027-12-06", "12:00");
      expect((await m.refresher.refreshClub(seasonId, "FLA3", afterSerieA, { fairValues: FAIR })).refreshed).toBe(true);
      accepted(await m.service.place(o.buyLimit(bruno, "SPT3", 1, 3500, { now: afterSerieA })));
      expect((await openOf(ana)).map((r) => r.id)).toEqual([buy.order.id, sale.order.id]);
      expect(await openOf(treasury)).toHaveLength(2 * TICKERS.length);

      // a final da Copa do Brasil em 2027-12-19 e a recompra fechada: o fim da negociação
      clock.set(RECOMPRA);
      const r = await end(RECOMPRA);
      expect(r).toMatchObject({ ended: true, seasonId, at: RECOMPRA, cancelled: 2 + 1 + 2 * TICKERS.length, droppedAuctions: [] });
      expect(await orderRow(db, buy.order.id)).toMatchObject({ status: "cancelled", cancelReason: "trading_end", reservedCash: 0 });
      expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "cancelled", cancelReason: "trading_end" });
      expect(await walletOf(db, ana)).toEqual({ cash: RICH, reservedCash: 0, free: RICH, openOrders: 0 });
      expect(await positionOf(db, ana, club("PAL3"))).toEqual({ shares: 100, reservedShares: 0, free: 100 });
      expect(await openOf(treasury)).toEqual([]);
      expect(await walletOf(db, treasury)).toMatchObject({ reservedCash: 0, openOrders: 0 });
      expect(await season()).toMatchObject({ status: "trading_ended", tradingEndedAt: RECOMPRA });

      // depois do fim: ordens novas de qualquer clube dão market_closed, a casa não repõe e não há leilão a fechar
      const after = later(RECOMPRA, 60_000);
      for (const ticker of TICKERS) {
        expect(rejected(await m.service.place(o.buyLimit(ana, ticker, 1, 4000, { now: after })))).toEqual({ ok: false, code: "market_closed" });
        expect(await m.refresher.refreshClub(seasonId, ticker, after, { fairValues: FAIR })).toMatchObject({ refreshed: false, reason: "market_closed" });
        expect(await m.closer.closeAuction(seasonId, ticker, after)).toMatchObject({ closed: false, reason: "not_in_auction" });
      }
      // o pedido de antes do fim que chega depois do COMMIT também é recusado
      expect(rejected(await m.service.place(o.sellLimit(ana, "PAL3", 1, 4000, { now: CUP_FINAL }))).code).toBe("market_closed");
      expect(await openOf(treasury)).toEqual([]);
    }),
  );

  it(
    "chamar endTrading duas vezes não faz nada na segunda",
    scene(async () => {
      const ana = await openPlayer(db, seasonId, RICH);
      await ready();
      accepted(await m.service.place(o.buyLimit(ana, "FLA3", 10, 3900)));
      const first = await end(RECOMPRA);
      expect(first).toMatchObject({ ended: true, cancelled: 1, walletIds: [ana] });
      const counts = await rowCounts(db);
      const before = await season();
      const second = await end(later(RECOMPRA, HOUR));
      expect(second).toEqual({ ended: false, seasonId, at: RECOMPRA, cancelled: 0, walletIds: [], droppedAuctions: [] });
      expect(await rowCounts(db)).toEqual(counts);
      expect(await season()).toEqual(before);
    }),
  );

  it(
    "L7: endTrading com um leilão aberto (e outro parado pela suspensão) não gera negócio, cancela tudo e limpa o leilão",
    scene(async () => {
      const bruno = await openPlayer(db, seasonId, RICH);
      await giveShares(db, bruno, club("FLA3"), 500);
      const davi = await openPlayer(db, seasonId, RICH);
      await giveShares(db, davi, club("FLA3"), 500);
      const ana = await openPlayer(db, seasonId, RICH);
      await ready();
      const t1210 = brt("2027-12-06", "12:10");
      accepted(await m.service.place(o.sellLimit(bruno, "FLA3", 50, 4300, { now: t1210 })));
      accepted(await m.service.place(o.sellLimit(davi, "FLA3", 100, 4450, { now: t1210 })));
      const anaBuy = accepted(await m.service.place(o.buyLimit(ana, "FLA3", 100, 4500, { now: brt("2027-12-06", "12:40") })));
      expect(anaBuy).toMatchObject({ openedAuction: true, trades: [] });
      // o PAL3 com o leilão parado pela suspensão (sem fim marcado)
      await setTunnelState(db, seasonId, club("PAL3"), { auctionOpenedAt: brt("2027-12-06", "11:00"), auctionUntil: null });
      const fla = await clubRow(db, seasonId, club("FLA3"));

      // o fim da negociação chega com o leilão do FLA3 já vencido e ainda não fechado: acaba sem negócio
      const r = await end(brt("2027-12-06", "16:00"));
      expect(r).toMatchObject({ ended: true, cancelled: 3, droppedAuctions: ["FLA3", "PAL3"] });
      expect(await db.select().from(trades).where(eq(trades.seasonId, seasonId))).toEqual([]);
      expect(await orderRow(db, anaBuy.order.id)).toMatchObject({ status: "cancelled", cancelReason: "trading_end", filled: 0 });
      expect(await walletOf(db, ana)).toMatchObject({ cash: RICH, reservedCash: 0, openOrders: 0 });
      for (const ticker of ["FLA3", "PAL3"]) {
        expect(await clubRow(db, seasonId, club(ticker))).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });
      }
      // a referência do túnel e o preço exibido ficam como estavam
      expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ lastPrice: fla.lastPrice, tunnelRef: fla.tunnelRef });
      expect(await m.closer.closeAuction(seasonId, "FLA3", brt("2027-12-06", "16:01"))).toMatchObject({ closed: false, reason: "not_in_auction" });
    }),
  );
});

// ------------------------------------------------------------------------------------------- no app

describe("o fim da negociação no app", () => {
  const t = useTestDatabase(8);
  const clock = new FixedClock(RECOMPRA);
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ db: t.db, clock });
  });
  afterAll(() => app?.close());

  it("o app entrega o EndTradingService, e o fim publica season.status com trading_ended depois do COMMIT", async () => {
    const { seasonId } = await marketSeason(t.db, { tickers: TICKERS });
    const got: { type: string; data: Record<string, unknown> }[] = [];
    app.get(EventBus, { strict: false }).subscribe("season", (e) => got.push(JSON.parse(e.frame) as never));
    const ending = app.get(EndTradingService);
    const r = await withTransaction(t.db, async (tx) => {
      const result = await ending.endTrading(tx, RECOMPRA);
      expect(got).toEqual([]);
      return result;
    });
    expect(r).toMatchObject({ ended: true, seasonId });
    const statuses = got.filter((f) => f.type === "season.status").map((f) => f.data);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ seasonId, status: "trading_ended", tradingOpensAt: "2027-04-05T13:00:00.000Z" });
    await app.get(BookPublisher).idle();
  });
});

// ------------------------------------------------------------------------------------------- concorrência

const ROUNDS = 50;
const START = new Date("2027-04-07T03:00:00Z");

describe("o fim da negociação com ordens e com o fim do leilão ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(30);
  const clock = new FixedClock(START);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let m: ReturnType<typeof marketServices>;
  let o: ReturnType<typeof orderInputs>;
  let ana: number, bruno: number, carla: number;
  let cashBefore: number;
  let retries = 0;
  const transaction = { onRetry: () => retries++ };
  let slot = 0;

  beforeAll(async () => {
    db = t.db;
    ({ seasonId, clubIds } = await marketSeason(db, { tickers: TICKERS }));
    m = marketServices(db, clock);
    o = orderInputs({ seasonId, now: START });
    [ana, bruno, carla] = (await openPlayerWallets(db, seasonId, 3, 50_000_000)) as [number, number, number];
    const treasury = await openTreasury(db, seasonId, 50_000_000);
    for (const ticker of TICKERS) {
      await giveShares(db, bruno, clubIds.get(ticker)!, 2_000);
      await giveShares(db, treasury, clubIds.get(ticker)!, 600);
    }
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });
  afterAll(async () => {
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
  });

  const club = (ticker: string) => clubIds.get(ticker)!;
  /** A negociação aberta de novo para a rodada seguinte (o fim é de mentira: só os testes voltam atrás). */
  const reopen = async (at: Date) => {
    await db.update(seasons).set({ status: "trading", tradingEndedAt: null }).where(eq(seasons.id, seasonId));
    for (const ticker of TICKERS) {
      await setTunnelState(db, seasonId, club(ticker), { lastPrice: 4000, tunnelRef: 4000, tunnelRefDay: new Date(dayStart(at.getTime())) });
    }
  };
  /** O fim da negociação numa transação que espera (com tudo travado) até o teste soltar. */
  const heldEnd = (at: Date, hold?: () => Promise<void>) =>
    withTransaction(
      db,
      async (tx) => {
        const r = await m.ending.endTrading(tx, at);
        if (hold) await hold();
        return r;
      },
      transaction,
    );
  const holder = () => {
    const gate = deferred();
    const holding = deferred();
    return {
      gate,
      holding,
      hold: async () => {
        holding.resolve();
        await gate.promise;
      },
    };
  };
  const tradesSince = (from: Date) => db.select().from(trades).where(and(eq(trades.seasonId, seasonId), gt(trades.at, later(from, -1)))).orderBy(asc(trades.id));
  const endedAt = async () => (await db.select({ at: seasons.tradingEndedAt }).from(seasons).where(eq(seasons.id, seasonId)))[0]!.at!;

  it("ordens chegando em vários clubes durante o endTrading: executam antes (e o fim fica depois delas) ou dão market_closed; nenhum negócio depois de trading_ended_at (50 repetições)", async () => {
    const outcomes = { before: 0, after: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const at = new Date(START.getTime() + HOUR * slot++);
      await reopen(at);
      expect((await m.refresher.refreshClub(seasonId, "FLA3", later(at, -60_000), { fairValues: FAIR, transaction })).refreshed).toBe(true);
      for (const ticker of ["FLA3", "PAL3"]) accepted(await m.service.place(o.sellLimit(bruno, ticker, 1, 4000, { now: later(at, -60_000) }), { transaction }));

      const endFirst = round % 2 === 0;
      // a cada quatro rodadas, as ordens chegam com o relógio 1 s antes ou 1 s depois do instante pedido para o fim
      const orderNow = later(at, (round >> 1) % 2 === 0 ? 1_000 : -1_000);
      const buyBoth = (hold?: () => Promise<void>) =>
        Promise.all([
          m.service.place(o.buyLimit(ana, "FLA3", 1, 4000, { now: orderNow }), { hooks: hold ? { afterReadBeforeLock: hold } : undefined, transaction }),
          m.service.place(o.buyLimit(carla, "PAL3", 1, 4000, { now: orderNow }), { hooks: hold ? { afterReadBeforeLock: hold } : undefined, transaction }),
        ]);
      let placed: Promise<PlaceOrderResult[]>;
      let ended: Promise<EndTradingResult>;
      if (endFirst) {
        const h = holder();
        ended = heldEnd(at, h.hold);
        await h.holding.promise;
        placed = buyBoth();
        await waitForBlocked(db, 2);
        h.gate.resolve();
      } else {
        // as duas ordens travam os clubes delas e esperam; o fim chega e fica parado na trava do primeiro
        const gate = deferred();
        let arrived = 0;
        const both = deferred();
        const hold = async () => {
          if (++arrived === 2) both.resolve();
          await gate.promise;
        };
        placed = buyBoth(hold);
        await both.promise;
        ended = heldEnd(at);
        await waitForBlocked(db, 1);
        gate.resolve();
      }
      const [results, r] = await Promise.all([placed, ended]);
      expect(r.ended).toBe(true);
      const stamp = await endedAt();
      expect(r.at).toEqual(stamp);
      const roundTrades = await tradesSince(later(at, -60_000));
      if (endFirst) {
        outcomes.after++;
        for (const x of results) expect(rejected(x).code).toBe("market_closed");
        expect(roundTrades).toEqual([]);
        expect(stamp).toEqual(at);
      } else {
        outcomes.before++;
        for (const x of results) expect(accepted(x).trades).toHaveLength(1);
        expect(roundTrades).toHaveLength(2);
        // o fim nunca fica antes do último negócio
        expect(stamp.getTime()).toBe(Math.max(at.getTime(), orderNow.getTime()));
      }
      for (const x of roundTrades) expect(x.at.getTime()).toBeLessThanOrEqual(stamp.getTime());
      expect(await db.select().from(orders).where(and(eq(orders.seasonId, seasonId), eq(orders.status, "open")))).toEqual([]);
    }
    expect(outcomes).toEqual({ before: 25, after: 25 });
  }, 240_000);

  it("fim da negociação e fim do leilão ao mesmo tempo: o leilão fecha antes (e o fim fica depois dele) ou acaba sem negócio (50 repetições)", async () => {
    const outcomes = { closedFirst: 0, endedFirst: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const opened = new Date(START.getTime() + HOUR * 4 * slot++);
      const until = later(opened, 3 * HOUR);
      await reopen(opened);
      await setTunnelState(db, seasonId, club("FLA3"), { auctionOpenedAt: opened, auctionUntil: until });
      accepted(await m.service.place(o.sellLimit(bruno, "FLA3", 10, 3900, { now: later(opened, HOUR) }), { transaction }));
      const buy = accepted(await m.service.place(o.buyLimit(ana, "FLA3", 20, 4500, { now: later(opened, HOUR) }), { transaction }));

      const closeFirst = round % 2 === 0;
      // o relógio da F15 pode estar 1 s atrás do fim do leilão, ou na hora dele
      const endAt = (round >> 1) % 2 === 0 ? until : later(until, -1_000);
      const h = holder();
      let closing: Promise<CloseAuctionResult>;
      let ended: Promise<EndTradingResult>;
      if (closeFirst) {
        closing = m.closer.closeAuction(seasonId, "FLA3", until, { afterClubLock: h.hold, transaction });
        await h.holding.promise;
        ended = heldEnd(endAt);
      } else {
        ended = heldEnd(endAt, h.hold);
        await h.holding.promise;
        closing = m.closer.closeAuction(seasonId, "FLA3", until, { transaction });
      }
      await waitForBlocked(db, 1);
      h.gate.resolve();
      const [c, r] = await Promise.all([closing, ended]);
      const stamp = await endedAt();
      const auctionTrades = await db.select().from(trades).where(eq(trades.buyOrderId, buy.order.id));
      if (closeFirst) {
        outcomes.closedFirst++;
        expect(c.closed).toBe(true);
        expect(auctionTrades.map((x) => [x.quantity, x.inAuction, x.at])).toEqual([[10, true, until]]);
        expect(r.droppedAuctions).toEqual([]);
        expect(stamp).toEqual(until);
      } else {
        outcomes.endedFirst++;
        expect(c).toMatchObject({ closed: false, reason: "not_in_auction" });
        expect(auctionTrades).toEqual([]);
        expect(r.droppedAuctions).toEqual(["FLA3"]);
        expect(stamp).toEqual(endAt);
      }
      for (const x of auctionTrades) expect(x.at.getTime()).toBeLessThanOrEqual(stamp.getTime());
      expect(await orderRow(db, buy.order.id)).toMatchObject({ status: "cancelled", cancelReason: "trading_end" });
      expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });
    }
    expect(outcomes).toEqual({ closedFirst: 25, endedFirst: 25 });
  }, 240_000);
});

// ------------------------------------------------------------------------------------------- medição

describe("o fim da negociação com alguns milhares de ordens abertas (medição)", () => {
  const t = useTestDatabase(12);
  const WALLETS = 200;
  const PER_WALLET = 15;

  it(`cancela ${WALLETS * PER_WALLET} ordens abertas de ${WALLETS} carteiras em 4 clubes numa transação`, async () => {
    const db = t.db;
    const tickers = ["FLA3", "PAL3", "SPT3", "COR3"];
    const { seasonId } = await marketSeason(db, { tickers });
    const clock = new FixedClock(START);
    const m = marketServices(db, clock);
    const o = orderInputs({ seasonId, now: START });
    const wallets = (await openPlayerWallets(db, seasonId, WALLETS, 10_000_000)) as number[];
    await syncTotalShares(db, seasonId);
    const cashBefore = await totalCash(db, seasonId);
    const placing = Date.now();
    for (let i = 0; i < wallets.length; i += 10) {
      await Promise.all(
        wallets.slice(i, i + 10).map(async (wallet) => {
          for (let k = 0; k < PER_WALLET; k++) accepted(await m.service.place(o.buyLimit(wallet, tickers[k % 4]!, 1, 3600 + k)));
        }),
      );
    }
    const placingMs = Date.now() - placing;

    const started = performance.now();
    const r = await withTransaction(db, (tx) => m.ending.endTrading(tx, later(START, HOUR)));
    const elapsed = performance.now() - started;
    console.log(`endTrading: ${r.cancelled} ordens de ${r.walletIds.length} carteiras em ${elapsed.toFixed(0)} ms (colocar as ordens levou ${placingMs} ms)`);
    expect(r).toMatchObject({ ended: true, cancelled: WALLETS * PER_WALLET });
    expect(await db.select().from(orders).where(and(eq(orders.seasonId, seasonId), eq(orders.status, "open")))).toEqual([]);
    await assertMarketInvariants(db, seasonId, cashBefore);
  }, 600_000);
});
