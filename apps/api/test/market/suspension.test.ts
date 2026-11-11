import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { type Tx } from "../../src/infra/db/index.js";
import { marketRefreshRequests, orders, seasonClubs, seasons, trades } from "../../src/infra/db/schema/index.js";
import type { AdminEvents } from "../../src/modules/admin/events.js";
import { AdminLogService } from "../../src/modules/admin/log/index.js";
import { MarketPort, type RefreshReason } from "../../src/modules/admin/results/ports.js";
import { SuspensionService } from "../../src/modules/admin/suspension/suspension.service.js";
import {
  BookPublisher,
  CancelService,
  CloseAuctionAdapter,
  CloseAuctionService,
  MarketPortImpl,
  OrderService,
  PostgresMatchingEngine,
  RefreshService,
  RefreshWaker,
  type ClubRefreshed,
  type RefreshResult,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createTestApp } from "../support/app.js";
import { useTestDatabase } from "../support/db.js";
import { createUser, deferred } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
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
  setTunnelState,
  syncTotalShares,
  waitForBlocked,
  walletOf,
} from "./order-helpers.js";

// T13 do Plano do livro de ofertas e formador: a porta do mercado de verdade (`MarketPortImpl`) na suspensão e na
// retomada (Livro de ofertas e formador de mercado, critério 32; Admin, critérios 23 e 24). No fim do arquivo, a porta
// ligada no app e a ordem e a suspensão ao mesmo tempo, 50 repetições.

/** Um instante pelo relógio de Brasília. */
const brt = (day: string, time: string) => new Date(`${day}T${time}:00-03:00`);
const TODAY = brt("2027-04-06", "00:00");
const T1000 = brt("2027-04-06", "10:00");
const T1100 = brt("2027-04-06", "11:00");
const T1200 = brt("2027-04-06", "12:00");
const TICKERS = ["FLA3", "PAL3"];
const RICH = 10_000_000;
const FAIR = new Map<string, Cents>(TICKERS.map((t) => [t, 4200]));
const noFairValue = { compute: async (): Promise<Map<string, Cents>> => new Map() };
/** A suspensão avisa o admin pelo `AdminEvents`; aqui ninguém escuta. */
const quietAdminEvents = { marketSuspended() {}, marketResumed() {} } as unknown as AdminEvents;

function refreshed(result: RefreshResult): ClubRefreshed {
  if (!result.refreshed) throw new Error(`a reposição devia cotar e não cotou: ${result.reason}`);
  return result;
}

describe("suspensão pela porta do mercado de verdade", () => {
  const t = useTestDatabase(5);
  const clock = new FixedClock(T1000);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let service: OrderService;
  let cancels: CancelService;
  let refresher: RefreshService;
  let suspension: SuspensionService;
  let admin: string;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number | undefined;
  /** As reposições que a retomada acordou (pelo `RefreshWaker`), na ordem. */
  let woken: { tickers: string[]; reason: RefreshReason; results: RefreshResult[] }[];

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      clock.set(T1000);
      treasury = await openTreasury(db, seasonId, RICH);
      const ledger = new PortfolioLedger();
      const adapter = new CloseAuctionAdapter(new CloseAuctionService(db, ledger));
      service = new OrderService(db, new PostgresMatchingEngine(ledger), adapter);
      cancels = new CancelService(db, ledger, adapter);
      const waker = new RefreshWaker();
      refresher = new RefreshService(db, service, cancels, noFairValue, clock, adapter, undefined, waker);
      // a agenda (T11) se inscreve assim: a retomada cota na mesma hora
      woken = [];
      waker.onWake(async (request) => {
        const results: RefreshResult[] = [];
        for (const ticker of request.tickers) results.push(await refresher.refreshClub(request.seasonId, ticker, clock.now(), { fairValues: FAIR }));
        woken.push({ tickers: request.tickers, reason: request.reason, results });
      });
      suspension = new SuspensionService(db, new AdminLogService(clock, db), new MarketPortImpl(cancels, refresher, clock), quietAdminEvents);
      admin = await createUser(db);
      o = orderInputs({ seasonId, now: T1000 });
      cashBefore = undefined;
      await body();
      if (cashBefore === undefined) throw new Error("o teste não chamou ready() depois de montar as carteiras");
      await assertMarketInvariants(db, seasonId, cashBefore);
    });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const holder = async (ticker: string, shares: number) => {
    const wallet = await openPlayer(db, seasonId, RICH);
    await giveShares(db, wallet, club(ticker), shares);
    return wallet;
  };
  const ready = async () => {
    for (const ticker of TICKERS) {
      await giveShares(db, treasury, club(ticker), 600);
      await setTunnelState(db, seasonId, club(ticker), { lastPrice: 4000, tunnelRef: 4000, tunnelRefDay: TODAY });
    }
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  };
  const refresh = (ticker: string, now: Date) => refresher.refreshClub(seasonId, ticker, now, { fairValues: FAIR });
  const houseQuotes = async (ticker: string) =>
    (
      await db
        .select({ side: orders.side, quantity: orders.quantity, filled: orders.filled, price: orders.limitPrice })
        .from(orders)
        .where(and(eq(orders.walletId, treasury), eq(orders.clubId, club(ticker)), eq(orders.status, "open")))
        .orderBy(asc(orders.side), asc(orders.id))
    ).map((r) => [r.side, r.quantity - r.filled, r.price]);
  const QUOTED = [
    ["buy", 10, 3990],
    ["sell", 10, 4410],
  ];
  const houseCancelled = (ticker: string) =>
    db
      .select({ reason: orders.cancelReason })
      .from(orders)
      .where(and(eq(orders.walletId, treasury), eq(orders.clubId, club(ticker)), eq(orders.status, "cancelled")));

  it(
    "livro 32: suspender o FLA3 tira as cotações da casa do livro e ela não cota; retomar cota de novo na mesma hora",
    scene(async () => {
      const bruno = await holder("FLA3", 1_000);
      await ready();
      refreshed(await refresh("FLA3", T1000));
      refreshed(await refresh("PAL3", T1000));
      expect(await houseQuotes("FLA3")).toEqual(QUOTED);
      const brunoSale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 20, 4300)));

      clock.set(T1100);
      await suspension.suspend(admin, { ticker: "FLA3", reason: "estádio interditado" });
      // as cotações da casa saem, com o motivo da suspensão; a venda de Bruno fica no livro e o PAL3 não muda
      expect(await houseQuotes("FLA3")).toEqual([]);
      expect((await houseCancelled("FLA3")).map((r) => r.reason)).toEqual(["suspension", "suspension"]);
      expect(await orderRow(db, brunoSale.order.id)).toMatchObject({ status: "open", cancelReason: null });
      expect(await houseQuotes("PAL3")).toEqual(QUOTED);
      expect(await walletOf(db, treasury)).toMatchObject({ openOrders: 2 });
      // a casa não cota durante a suspensão, nem pela agenda
      expect(await refresh("FLA3", brt("2027-04-06", "11:30"))).toMatchObject({ refreshed: false, reason: "club_suspended" });
      expect(await houseQuotes("FLA3")).toEqual([]);

      // a retomada grava o pedido e a reposição acordada na mesma hora o atende
      clock.set(T1200);
      await suspension.resume(admin, "FLA3");
      expect(woken).toHaveLength(1);
      expect(woken[0]).toMatchObject({ tickers: ["FLA3"], reason: "resume" });
      expect(refreshed(woken[0]!.results[0]!)).toMatchObject({ at: T1200, requestsDone: 1 });
      expect(await houseQuotes("FLA3")).toEqual(QUOTED);
      expect((await clubRow(db, seasonId, club("FLA3"))).mmRefreshedAt).toEqual(T1200);
      const requests = await db.select().from(marketRefreshRequests).where(eq(marketRefreshRequests.clubId, club("FLA3")));
      expect(requests.map((r) => [r.reason, r.requestedAt, r.doneAt])).toEqual([["resume", T1200, T1200]]);
    }),
  );

  it(
    "admin 23: com a porta de verdade, a ordem de FLA3 suspenso é recusada com o motivo e a de PAL3 executa",
    scene(async () => {
      const bruno = await holder("FLA3", 100);
      const carla = await holder("PAL3", 100);
      const ana = await openPlayer(db, seasonId, RICH);
      await ready();
      accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4000)));
      accepted(await service.place(o.sellLimit(carla, "PAL3", 10, 4000)));
      await suspension.suspend(admin, { ticker: "FLA3", reason: "Placar do jogo em revisão" });

      const before = await walletOf(db, ana);
      const refused = rejected(await service.place(o.buyLimit(ana, "FLA3", 10, 4000, { now: T1100 })));
      expect(refused).toEqual({ ok: false, code: "club_suspended", reason: "Placar do jogo em revisão" });
      expect(await walletOf(db, ana)).toEqual(before);
      const done = accepted(await service.place(o.buyLimit(ana, "PAL3", 10, 4000, { now: T1100 })));
      expect(done.trades.map((x) => [x.quantity, x.price])).toEqual([[10, 4000]]);
    }),
  );

  it(
    "admin 24: cancelar a venda de FLA3 durante a suspensão é aceito e as ações voltam a ficar livres; na retomada, as ordens que ficaram executam",
    scene(async () => {
      const bruno = await holder("FLA3", 100);
      const davi = await holder("FLA3", 100);
      const ana = await openPlayer(db, seasonId, RICH);
      await ready();
      const brunoSale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4050)));
      const daviSale = accepted(await service.place(o.sellLimit(davi, "FLA3", 10, 4100)));
      await suspension.suspend(admin, { ticker: "FLA3", reason: "estádio interditado" });

      const cancel = await cancels.cancelOrder({ walletId: bruno, orderId: brunoSale.order.id, now: T1100 });
      expect(cancel).toMatchObject({ ok: true, order: { status: "cancelled", cancelReason: "player" } });
      expect(await positionOf(db, bruno, club("FLA3"))).toEqual({ shares: 100, reservedShares: 0, free: 100 });
      expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 10, 4100, { now: T1100 }))).code).toBe("club_suspended");

      clock.set(T1200);
      await suspension.resume(admin, "FLA3");
      // a venda de Davi ficou no livro e executa com a compra de Ana depois da retomada
      const buy = accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4100, { now: T1200 })));
      expect(buy.trades.map((x) => [x.sellOrderId, x.quantity, x.price])).toEqual([[daviSale.order.id, 10, 4100]]);
      expect(await orderRow(db, daviSale.order.id)).toMatchObject({ status: "filled" });
    }),
  );

  it(
    "suspender o mercado todo tira a casa de todos os clubes e recusa ordens em todos; retomar cota de novo em todos",
    scene(async () => {
      const bruno = await holder("FLA3", 100);
      const ana = await openPlayer(db, seasonId, RICH);
      await ready();
      for (const ticker of TICKERS) refreshed(await refresh(ticker, T1000));
      const brunoSale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4300)));

      clock.set(T1100);
      await suspension.suspend(admin, { reason: "falha na fonte dos placares" });
      for (const ticker of TICKERS) {
        expect(await houseQuotes(ticker)).toEqual([]);
        expect(rejected(await service.place(o.buyLimit(ana, ticker, 1, 4000, { now: T1100 })))).toEqual({
          ok: false,
          code: "club_suspended",
          reason: "falha na fonte dos placares",
        });
        expect(await refresh(ticker, T1100)).toMatchObject({ refreshed: false, reason: "club_suspended" });
      }
      expect(await walletOf(db, treasury)).toMatchObject({ openOrders: 0, reservedCash: 0 });
      expect(await orderRow(db, brunoSale.order.id)).toMatchObject({ status: "open" });

      clock.set(T1200);
      await suspension.resume(admin, undefined);
      expect(woken.map((w) => w.tickers)).toEqual([TICKERS]);
      for (const ticker of TICKERS) expect(await houseQuotes(ticker)).toEqual(QUOTED);
      accepted(await service.place(o.buyLimit(ana, "PAL3", 1, 3990, { now: T1200 })));
    }),
  );

  it(
    "o mercado todo retomado com o FLA3 ainda suspenso à parte: a casa volta só no PAL3",
    scene(async () => {
      await ready();
      for (const ticker of TICKERS) refreshed(await refresh(ticker, T1000));
      await suspension.suspend(admin, { ticker: "FLA3", reason: "estádio interditado" });
      await suspension.suspend(admin, { reason: "falha na fonte dos placares" });
      await suspension.resume(admin, undefined);
      expect(woken.map((w) => w.tickers)).toEqual([["PAL3"]]);
      expect(await houseQuotes("FLA3")).toEqual([]);
      expect(await houseQuotes("PAL3")).toEqual(QUOTED);
      const pending = await db
        .select({ clubId: marketRefreshRequests.clubId })
        .from(marketRefreshRequests)
        .where(isNull(marketRefreshRequests.doneAt));
      expect(pending).toEqual([]);
    }),
  );
});

// ------------------------------------------------------------------------------------------- a porta no app

describe("a porta do mercado ligada no app", () => {
  const t = useTestDatabase(8);
  const clock = new FixedClock(T1000);
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ db: t.db, clock });
  });
  afterAll(() => app?.close());

  it("o app entrega o MarketPortImpl à suspensão, e suspender pelo app tira as cotações da casa", async () => {
    expect(app.get(MarketPort, { strict: false })).toBeInstanceOf(MarketPortImpl);
    const { seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS });
    const treasury = await openTreasury(t.db, seasonId, RICH);
    await giveShares(t.db, treasury, clubIds.get("FLA3")!, 600);
    await syncTotalShares(t.db, seasonId);
    const cashBefore = await totalCash(t.db, seasonId);
    refreshed(await app.get(RefreshService).refreshClub(seasonId, "FLA3", T1000, { fairValues: FAIR }));

    await app.get(SuspensionService, { strict: false }).suspend(await createUser(t.db), { ticker: "FLA3", reason: "estádio interditado" });
    const open = await t.db.select().from(orders).where(and(eq(orders.walletId, treasury), eq(orders.status, "open")));
    expect(open).toEqual([]);
    await assertMarketInvariants(t.db, seasonId, cashBefore);
    await app.get(BookPublisher).idle();
  });
});

// ------------------------------------------------------------------------------------------- concorrência

describe("ordem e suspensão ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(30);
  const clock = new FixedClock(T1000);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let service: OrderService;
  let refresher: RefreshService;
  let o: ReturnType<typeof orderInputs>;
  let ana: number, bruno: number, treasury: number;
  let admin: string;
  let suspension: SuspensionService;
  let cashBefore: number;
  let retries = 0;
  const transaction = { onRetry: () => retries++ };
  /** Segura a suspensão com o clube (ou os clubes) já travados, antes de tirar a casa. */
  let holdSuspension: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    db = t.db;
    ({ seasonId, clubIds } = await marketSeason(db, { tickers: TICKERS }));
    const ledger = new PortfolioLedger();
    const adapter = new CloseAuctionAdapter(new CloseAuctionService(db, ledger));
    service = new OrderService(db, new PostgresMatchingEngine(ledger), adapter);
    const cancels = new CancelService(db, ledger, adapter);
    refresher = new RefreshService(db, service, cancels, noFairValue, clock, adapter);
    const real = new MarketPortImpl(cancels, refresher, clock);
    const held = new (class extends MarketPort {
      async cancelHouseQuotes(tx: Tx, tickers: readonly string[]): Promise<void> {
        if (holdSuspension) await holdSuspension();
        await real.cancelHouseQuotes(tx, tickers);
      }
      requestRefresh(tx: Tx, tickers: readonly string[], reason: RefreshReason): Promise<void> {
        return real.requestRefresh(tx, tickers, reason);
      }
    })();
    suspension = new SuspensionService(db, new AdminLogService(clock, db), held, quietAdminEvents);
    o = orderInputs({ seasonId, now: T1000 });
    admin = await createUser(db);
    ana = await openPlayer(db, seasonId, 50_000_000);
    bruno = await openPlayer(db, seasonId, 50_000_000);
    treasury = await openTreasury(db, seasonId, 50_000_000);
    await giveShares(db, bruno, clubIds.get("FLA3")!, 1_000);
    await giveShares(db, treasury, clubIds.get("FLA3")!, 600);
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });

  it("a ordem executa antes da suspensão ou é recusada depois dela, sem deadlock, no clube e no mercado todo (50 repetições)", async () => {
    const outcomes = { executed: 0, refused: 0 };
    for (let round = 0; round < 50; round++) {
      const now = new Date(T1000.getTime() + round * 60_000);
      clock.set(now);
      await db.update(seasons).set({ suspendedReason: null }).where(eq(seasons.id, seasonId));
      await db.update(seasonClubs).set({ suspendedReason: null }).where(eq(seasonClubs.seasonId, seasonId));
      refreshed(await refresher.refreshClub(seasonId, "FLA3", now, { fairValues: FAIR, transaction }));
      const sale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 1, 4000, { now }), { transaction }));

      const market = round % 4 >= 2;
      const body = market ? { reason: `mercado ${round}` } : { ticker: "FLA3", reason: `clube ${round}` };
      const orderFirst = round % 2 === 0;
      const gate = deferred();
      const holding = deferred();
      const hold = async () => {
        holding.resolve();
        await gate.promise;
      };
      let place: Promise<Awaited<ReturnType<OrderService["place"]>>>;
      let suspend: Promise<unknown>;
      if (orderFirst) {
        // a ordem trava o clube e espera; a suspensão chega e fica parada na trava do clube
        place = service.place(o.buyLimit(ana, "FLA3", 1, 4000, { now }), { hooks: { afterReadBeforeLock: hold }, transaction });
        await holding.promise;
        suspend = suspension.suspend(admin, body);
      } else {
        // a suspensão trava o clube (ou todos) e espera; a ordem chega e fica parada na trava do clube
        holdSuspension = hold;
        suspend = suspension.suspend(admin, body);
        await holding.promise;
        holdSuspension = undefined;
        place = service.place(o.buyLimit(ana, "FLA3", 1, 4000, { now }), { transaction });
      }
      await waitForBlocked(db, 1);
      gate.resolve();
      const [result] = await Promise.all([place, suspend]);

      if (orderFirst) {
        outcomes.executed++;
        // contra a venda mais antiga de Bruno a R$ 40,00 (a de uma rodada recusada pode ter ficado no livro)
        expect(accepted(result).trades.map((x) => [x.quantity, x.price, x.at])).toEqual([[1, 4000, now]]);
      } else {
        outcomes.refused++;
        expect(rejected(result)).toEqual({ ok: false, code: "club_suspended", reason: body.reason });
        expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "open" });
      }
      // a casa saiu do livro do FLA3 nos dois casos
      const house = await db.select().from(orders).where(and(eq(orders.walletId, treasury), eq(orders.status, "open")));
      expect(house).toEqual([]);
      await suspension.resume(admin, market ? undefined : "FLA3");
    }
    const all = await db.select().from(trades).where(eq(trades.clubId, clubIds.get("FLA3")!));
    expect(all).toHaveLength(outcomes.executed);
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
    expect(outcomes.executed).toBe(25);
    expect(outcomes.refused).toBe(25);
  }, 240_000);
});
