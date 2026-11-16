import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeQuote, DEFAULT_MARKET_MAKER, type Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { marketRefreshRequests, orders, seasonClubs, seasons, trades } from "../../src/infra/db/schema/index.js";
import { EventBus, type BusEvent } from "../../src/infra/realtime/index.js";
import {
  BookPublisher,
  CancelService,
  CloseAuctionAdapter,
  CloseAuctionService,
  FairValueService,
  OrderService,
  PostgresMatchingEngine,
  RefreshService,
  RefreshWaker,
  type ClubRefreshed,
  type RefreshOptions,
  type RefreshResult,
  type RefreshWakeUp,
} from "../../src/modules/market/index.js";
import { setClubPrice } from "../../src/modules/market/book/book-repo.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { sleep } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { insertMatch, marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  clubRow,
  giveCash,
  giveShares,
  openBot,
  openPlayer,
  openTreasury,
  orderInputs,
  orderRow,
  rejected,
  rolledBack,
  setTunnelState,
  syncTotalShares,
} from "./order-helpers.js";

// T10 do Plano do livro de ofertas e formador: a reposição da casa num clube (`refreshClub`), pelo serviço, no banco
// (Livro de ofertas e formador de mercado, "Cotação do formador de mercado", critérios 12, 23, 24, 26, 29, 31, 34, 36
// e 37; P1 e P2), e o pedido de reposição (`requestRefresh`, P5). As corridas estão em `refresh-concurrency.test.ts`;
// a casa no leilão (L6), em `refresh-auction.test.ts`.

/** Um instante pelo relógio de Brasília. */
const brt = (day: string, time: string) => new Date(`${day}T${time}:00-03:00`);
const later = (at: Date, ms: number) => new Date(at.getTime() + ms);
/** Terça, 6 de abril de 2027, às 10h: a negociação abriu na véspera às 10h. */
const NOW = brt("2027-04-06", "10:00");
const TODAY = brt("2027-04-06", "00:00");
const HOUR = 3_600_000;
const TICKERS = ["FLA3", "PAL3", "SPT3"];
const RICH = 10_000_000;

/** A reposição foi feita: devolve o resultado já com o tipo certo. */
function refreshed(result: RefreshResult): ClubRefreshed {
  if (!result.refreshed) throw new Error(`a reposição devia cotar e não cotou: ${result.reason}`);
  return result;
}

/** O despertador da reposição com um inscrito (o que a T11 faz na subida) que anota cada pedido. */
function recordingWaker(): { waker: RefreshWaker; calls: RefreshWakeUp[] } {
  const waker = new RefreshWaker();
  const calls: RefreshWakeUp[] = [];
  waker.onWake((request) => {
    calls.push(request);
  });
  return { waker, calls };
}

/** Nos testes o valor justo vem pronto (`fairValues`); quem cair aqui esqueceu de passar. */
const NO_FAIR_VALUE = {
  compute: async (): Promise<Map<string, Cents>> => {
    throw new Error("o teste devia passar o valor justo");
  },
};

describe("reposição da casa", () => {
  const t = useTestDatabase(5);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let service: OrderService;
  let cancels: CancelService;
  let refresher: RefreshService;
  let waker: { waker: RefreshWaker; calls: RefreshWakeUp[] };
  let clock: FixedClock;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number | undefined;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  /** Cada teste numa transação desfeita no fim, com as invariantes do dinheiro e do livro conferidas antes. */
  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      treasury = await openTreasury(db, seasonId);
      const ledger = new PortfolioLedger();
      const adapter = new CloseAuctionAdapter(new CloseAuctionService(db, ledger));
      service = new OrderService(db, new PostgresMatchingEngine(ledger), adapter);
      cancels = new CancelService(db, ledger, adapter);
      clock = new FixedClock(NOW);
      waker = recordingWaker();
      refresher = new RefreshService(db, service, cancels, NO_FAIR_VALUE, clock, adapter, undefined, waker.waker);
      o = orderInputs({ seasonId, now: NOW });
      cashBefore = undefined;
      await body();
      if (cashBefore === undefined) throw new Error("o teste não chamou ready() depois de montar as carteiras");
      await assertMarketInvariants(db, seasonId, cashBefore);
    });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const player = (cash = RICH) => openPlayer(db, seasonId, cash);
  const holder = async (ticker: string, shares: number, cash = RICH) => {
    const wallet = await player(cash);
    await giveShares(db, wallet, club(ticker), shares);
    return wallet;
  };
  /** A tesouraria com caixa e ações dos clubes dados. */
  const stock = async (cash: number, shares: Record<string, number>) => {
    if (cash > 0) await giveCash(db, treasury, cash);
    for (const [ticker, quantity] of Object.entries(shares)) await giveShares(db, treasury, club(ticker), quantity);
  };
  const ready = async () => {
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  };
  const row = (ticker: string) => clubRow(db, seasonId, club(ticker));
  const refresh = (ticker: string, fairValue: Cents, now = NOW, extra: RefreshOptions = {}) =>
    refresher.refreshClub(seasonId, ticker, now, { fairValues: new Map([[ticker, fairValue]]), ...extra });
  /** As cotações abertas da casa no clube: `[lado, quantidade que falta, preço]`, a compra antes da venda. */
  const houseQuotes = async (ticker: string) =>
    (
      await db
        .select({ side: orders.side, quantity: orders.quantity, filled: orders.filled, price: orders.limitPrice })
        .from(orders)
        .where(and(eq(orders.walletId, treasury), eq(orders.clubId, club(ticker)), eq(orders.status, "open")))
        .orderBy(asc(orders.side), asc(orders.id))
    ).map((r) => [r.side, r.quantity - r.filled, r.price]);
  /** O preço exibido e a referência do túnel gravados à mão, para o dia de hoje. */
  const priceAt = (ticker: string, price: number) =>
    setTunnelState(db, seasonId, club(ticker), { lastPrice: price, tunnelRef: price, tunnelRefDay: TODAY });
  const requests = (ticker: string) =>
    db.select().from(marketRefreshRequests).where(eq(marketRefreshRequests.clubId, club(ticker))).orderBy(asc(marketRefreshRequests.id));
  const request = (tickers: string[], reason: "score" | "correction" | "close" | "resume" = "score") =>
    withTransaction(db, (tx) => refresher.requestRefresh(tx, tickers, reason));

  it(
    "livro 23: com 3.000 ações e valor justo de R$ 42,00, a casa compra 10 a R$ 39,90 e vende 10 a R$ 44,10; no modo de jogo, 3 por lado a R$ 39,06 e R$ 44,94",
    scene(async () => {
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      await ready();

      const first = refreshed(await refresh("FLA3", 4200));
      // 0,25% de 3.000 dá 7, abaixo do mínimo de 10
      expect(first).toMatchObject({ inMatch: false, size: 10, fairValue: 4200, trades: [], cancelled: [], openedAuction: false, auction: null });
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 10, 4410],
      ]);
      expect((await row("FLA3")).mmRefreshedAt).toEqual(NOW);

      // às 16h começa Flamengo × Palmeiras: a casa passa ao modo de jogo (faixa de 14%; 0,06% dá 1, abaixo do mínimo de 3)
      const kickoff = brt("2027-04-06", "16:00");
      await insertMatch(db, { seasonId, homeClubId: club("FLA3"), awayClubId: club("PAL3"), kickoff });
      const second = refreshed(await refresh("FLA3", 4200, kickoff));
      expect(second).toMatchObject({ inMatch: true, size: 3 });
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 3, 3906],
        ["sell", 3, 4494],
      ]);
      // as cotações velhas saíram do livro com o motivo da reposição e sem reserva
      expect(second.cancelled.map((c) => [c.side, c.status, c.cancelReason, c.reservedCash])).toEqual([
        ["buy", "cancelled", "house_refresh", 0],
        ["sell", "cancelled", "house_refresh", 0],
      ]);
      expect((await orderRow(db, first.bid!.order.id)).cancelReason).toBe("house_refresh");
      expect((await row("FLA3")).mmRefreshedAt).toEqual(kickoff);
    }),
  );

  it(
    "referência que decai (rodada Z): 2 dias e 1 hora sem negócio, preço de R$ 30,00 e justo de R$ 16,00, a referência vira R$ 27,00, o túnel vai com ela e a casa cota a partir dela",
    scene(async () => {
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      const bia = await player();
      await ready();
      const lastTrade = later(NOW, -(48 * HOUR + HOUR));
      await setTunnelState(db, seasonId, club("FLA3"), { lastPrice: 3000, lastTradeAt: lastTrade, tunnelRef: 3000, tunnelRefDay: TODAY });

      refreshed(await refresh("FLA3", 1600));
      const after = await row("FLA3");
      expect(after.referencePrice).toBe(2700);
      expect(after.lastPrice).toBe(3000);
      expect(after.tunnelRef).toBe(2700);
      // compra a 95% do justo (R$ 15,20); venda presa a 95% da referência (R$ 25,65), não a 95% de R$ 30,00
      expect((await houseQuotes("FLA3")).map(([side, , price]) => [side, price])).toEqual([
        ["buy", 1520],
        ["sell", 2565],
      ]);
      // a faixa de 20% passa a ser a da referência (R$ 21,60 a R$ 32,40)
      accepted(await service.place(o.buyLimit(bia, "FLA3", 1, 2160)));
      expect(rejected(await service.place(o.buyLimit(bia, "FLA3", 1, 2159))).code).toBe("price_out_of_band");
    }),
  );

  it(
    "referência que decai: com menos de 2 dias sem negócio, ou com o preço a até 20% do justo, a referência fica vazia; um negócio apaga a que existia",
    scene(async () => {
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      await ready();
      // 1 dia sem negócio: carência
      await setTunnelState(db, seasonId, club("FLA3"), { lastPrice: 3000, lastTradeAt: later(NOW, -24 * HOUR), tunnelRef: 3000, tunnelRefDay: TODAY });
      refreshed(await refresh("FLA3", 1600));
      expect((await row("FLA3")).referencePrice).toBeNull();
      // 5 dias sem negócio, mas o preço está a 12,5% do justo
      await setTunnelState(db, seasonId, club("FLA3"), { lastPrice: 1800, lastTradeAt: later(NOW, -120 * HOUR) });
      refreshed(await refresh("FLA3", 1600));
      expect((await row("FLA3")).referencePrice).toBeNull();
      // longe do justo e parado há 5 dias: decai; um negócio apaga
      await setTunnelState(db, seasonId, club("FLA3"), { lastPrice: 3000, lastTradeAt: later(NOW, -120 * HOUR) });
      refreshed(await refresh("FLA3", 1600));
      expect((await row("FLA3")).referencePrice).toBe(1969);
      await withTransaction(db, (tx) => setClubPrice(tx, seasonId, club("FLA3"), 2000, NOW));
      const traded = await row("FLA3");
      expect(traded.referencePrice).toBeNull();
      expect(traded.lastPrice).toBe(2000);
    }),
  );

  it(
    "livro 24: com 41.250 ações e valor justo de R$ 42,00, a casa cota 103 por lado a R$ 39,90 e R$ 44,10 e, no modo de jogo, 24 por lado a R$ 39,06 e R$ 44,94",
    scene(async () => {
      await stock(RICH, { FLA3: 8_250 });
      await holder("FLA3", 33_000);
      await ready();

      refreshed(await refresh("FLA3", 4200));
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 103, 3990],
        ["sell", 103, 4410],
      ]);
      const kickoff = brt("2027-04-06", "16:00");
      await insertMatch(db, { seasonId, homeClubId: club("FLA3"), awayClubId: club("PAL3"), kickoff });
      refreshed(await refresh("FLA3", 4200, later(kickoff, 60_000)));
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 24, 3906],
        ["sell", 24, 4494],
      ]);
    }),
  );

  it(
    "livro 12: com o valor justo em R$ 30,00 e o preço exibido em R$ 60,00, a casa vende a R$ 57,00 e compra a R$ 28,50; Ana compra da casa a R$ 57,00 e, na reposição seguinte, a casa vende a R$ 54,15",
    scene(async () => {
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      const ana = await player();
      await ready();
      await priceAt("FLA3", 6000);

      refreshed(await refresh("FLA3", 3000));
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 2850],
        ["sell", 10, 5700],
      ]);

      const purchase = accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 5800, { now: later(NOW, 60_000) })));
      expect(purchase.trades.map((x) => [x.price, x.quantity, x.withHouse])).toEqual([[5700, 10, true]]);
      expect((await row("FLA3")).lastPrice).toBe(5700);

      refreshed(await refresh("FLA3", 3000, later(NOW, 2 * HOUR)));
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 2850],
        ["sell", 10, 5415],
      ]);
    }),
  );

  it(
    "livro 36: com o valor justo do PAL3 em R$ 40,00 e o preço exibido em R$ 20,00, a casa compra a R$ 21,00 e vende a R$ 42,00; Bruno vende 10 a mercado à casa a R$ 21,00",
    scene(async () => {
      await stock(RICH, { PAL3: 600 });
      const bruno = await holder("PAL3", 2_400);
      await ready();
      await priceAt("PAL3", 2000);

      refreshed(await refresh("PAL3", 4000));
      expect(await houseQuotes("PAL3")).toEqual([
        ["buy", 10, 2100],
        ["sell", 10, 4200],
      ]);
      const sale = accepted(await service.place(o.sellMarket(bruno, "PAL3", 10, undefined, { now: later(NOW, 60_000) })));
      expect(sale.trades.map((x) => [x.price, x.quantity, x.withHouse, x.buyerWalletId])).toEqual([[2100, 10, true, treasury]]);
    }),
  );

  it(
    "livro 37: com o valor justo em R$ 30,00 e o preço exibido em R$ 60,00, no modo de jogo a casa vende a R$ 57,00 e compra a R$ 27,90",
    scene(async () => {
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      await ready();
      await priceAt("FLA3", 6000);

      // o modo de jogo já lido por quem chama (a tarefa da agenda lê todos os clubes de uma vez)
      const r = refreshed(await refresh("FLA3", 3000, NOW, { inMatch: true }));
      expect(r).toMatchObject({ inMatch: true, size: 3 });
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 3, 2790],
        ["sell", 3, 5700],
      ]);
    }),
  );

  it(
    "livro 29: com a tesouraria sem ações livres de FLA3 e com caixa, a casa só cota a compra",
    scene(async () => {
      await stock(RICH, {});
      await holder("FLA3", 3_000);
      await ready();

      const r = refreshed(await refresh("FLA3", 4200));
      expect(r.quote).toEqual({ bid: { price: 3990, quantity: 10 } });
      expect(r.ask).toBeNull();
      expect(await houseQuotes("FLA3")).toEqual([["buy", 10, 3990]]);
    }),
  );

  it(
    "livro 29: com R$ 200,00 livres na tesouraria (o resto preso na compra da casa no PAL3) e ações, a casa compra 5 a R$ 39,90 e vende 10 normal",
    scene(async () => {
      // R$ 399,00 da compra de 10 PAL3 a R$ 39,90 + R$ 200,00 livres
      await stock(39_900 + 20_000, { FLA3: 600, PAL3: 600 });
      await holder("FLA3", 2_400);
      await holder("PAL3", 2_400);
      await ready();

      refreshed(await refresh("PAL3", 4200));
      expect(await houseQuotes("PAL3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 10, 4410],
      ]);
      const r = refreshed(await refresh("FLA3", 4200));
      expect(r.quote).toEqual({ bid: { price: 3990, quantity: 5 }, ask: { price: 4410, quantity: 10 } });
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 5, 3990],
        ["sell", 10, 4410],
      ]);
    }),
  );

  it(
    "livro 29: com a tesouraria sem caixa, a casa só cota a venda",
    scene(async () => {
      await stock(0, { FLA3: 600 });
      await holder("FLA3", 2_400);
      await ready();

      const r = refreshed(await refresh("FLA3", 4200));
      expect(r.quote).toEqual({ ask: { price: 4410, quantity: 10 } });
      expect(r.bid).toBeNull();
      expect(await houseQuotes("FLA3")).toEqual([["sell", 10, 4410]]);
    }),
  );

  it(
    "livro 31: depois de 134 FLA3 irem para a tesouraria, a reposição seguinte volta a vender",
    scene(async () => {
      await stock(RICH, {});
      await holder("FLA3", 2_866);
      // Davi entra no meio da temporada só com caixa
      await player();
      await ready();

      refreshed(await refresh("FLA3", 4200));
      expect(await houseQuotes("FLA3")).toEqual([["buy", 10, 3990]]);

      // as 134 ações emitidas para Davi ficam na tesouraria (Entrada no meio da temporada, só caixa)
      await giveShares(db, treasury, club("FLA3"), 134);
      await syncTotalShares(db, seasonId);
      // até a reposição seguinte nada muda no livro
      expect(await houseQuotes("FLA3")).toEqual([["buy", 10, 3990]]);

      refreshed(await refresh("FLA3", 4200, brt("2027-04-06", "12:00")));
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 10, 4410],
      ]);
    }),
  );

  it(
    "livro 34: o percentual novo vale na reposição seguinte, não antes: com 1%, a casa cota 30 por lado num clube de 3.000",
    scene(async () => {
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      await ready();

      refreshed(await refresh("FLA3", 4200));
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 10, 4410],
      ]);
      // o admin muda o percentual (a rota, com o motivo e o registro, é a T15): o livro não muda na hora
      await db.update(seasons).set({ mmQuantityBp: 100 }).where(eq(seasons.id, seasonId));
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 10, 4410],
      ]);

      const r = refreshed(await refresh("FLA3", 4200, brt("2027-04-06", "12:00")));
      expect(r.size).toBe(30);
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 30, 3990],
        ["sell", 30, 4410],
      ]);
    }),
  );

  it(
    "P2: a cotação nova que cruza a venda de um jogador executa com a casa pelo preço dele e muda o preço exibido; a que cruza a compra de um bot também",
    scene(async () => {
      await stock(RICH, { FLA3: 600, PAL3: 600 });
      const bruno = await holder("FLA3", 2_400);
      await holder("PAL3", 2_400);
      const bot = await openBot(db, seasonId, RICH);
      await ready();

      // o preço andou: Bruno vende 5 a R$ 39,00, abaixo da compra nova da casa (R$ 39,90)
      const sale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 5, 3900)));
      const fla = refreshed(await refresh("FLA3", 4200, later(NOW, 60_000)));
      expect(fla.trades.map((x) => [x.sellOrderId, x.price, x.quantity, x.withHouse, x.priceBefore])).toEqual([
        [sale.order.id, 3900, 5, true, 4000],
      ]);
      expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "filled", filled: 5 });
      expect((await row("FLA3")).lastPrice).toBe(3900);
      // a sobra da compra fica no livro; a venda foi calculada com o preço exibido de antes
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 5, 3990],
        ["sell", 10, 4410],
      ]);
      const [withHouse] = await db.select().from(trades).where(eq(trades.sellOrderId, sale.order.id));
      expect(withHouse).toMatchObject({ withHouse: true, buyerWalletId: treasury, inAuction: false });

      // no PAL3, o bot compra 4 a R$ 44,50, acima da venda nova da casa (R$ 44,10)
      await priceAt("PAL3", 4200);
      const botBuy = accepted(await service.place({ ...o.buyLimit(bot, "PAL3", 4, 4450), actor: "bot" }));
      const pal = refreshed(await refresh("PAL3", 4200, later(NOW, 2 * 60_000)));
      expect(pal.trades.map((x) => [x.buyOrderId, x.price, x.quantity, x.withHouse])).toEqual([[botBuy.order.id, 4450, 4, true]]);
      expect((await row("PAL3")).lastPrice).toBe(4450);
      expect(await houseQuotes("PAL3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 6, 4410],
      ]);
    }),
  );

  it(
    "clube suspenso, mercado suspenso ou fechado: a casa não cota e o pedido fica aberto até a retomada",
    scene(async () => {
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      await ready();
      const clubWhere = and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club("FLA3")));

      await db.update(seasonClubs).set({ suspendedReason: "investigação" }).where(clubWhere);
      await request(["FLA3"], "resume");
      expect(await refresh("FLA3", 4200)).toEqual({ refreshed: false, reason: "club_suspended", seasonId, ticker: "FLA3" });
      expect(await houseQuotes("FLA3")).toEqual([]);
      expect((await requests("FLA3")).map((r) => r.doneAt)).toEqual([null]);
      expect((await row("FLA3")).mmRefreshedAt).toBeNull();

      // o mercado todo suspenso também para a casa
      await db.update(seasonClubs).set({ suspendedReason: null }).where(clubWhere);
      await db.update(seasons).set({ suspendedReason: "pane" }).where(eq(seasons.id, seasonId));
      expect(await refresh("FLA3", 4200)).toMatchObject({ refreshed: false, reason: "club_suspended" });
      await db.update(seasons).set({ suspendedReason: null }).where(eq(seasons.id, seasonId));

      // antes da abertura da negociação, nada
      expect(await refresh("FLA3", 4200, brt("2027-04-05", "09:59"))).toMatchObject({ refreshed: false, reason: "market_closed" });
      expect(await houseQuotes("FLA3")).toEqual([]);
      expect((await requests("FLA3")).map((r) => r.doneAt)).toEqual([null]);

      // retomado: a reposição cota e atende o pedido
      const r = refreshed(await refresh("FLA3", 4200));
      expect(r.requestsDone).toBe(1);
      expect((await requests("FLA3")).map((x) => x.doneAt)).toEqual([NOW]);
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 10, 4410],
      ]);
    }),
  );

  it(
    "requestRefresh: um pedido por clube com o motivo, acordando a reposição só depois do COMMIT; a transação desfeita não pede nada",
    scene(async () => {
      await ready();
      clock.set(brt("2027-04-06", "18:40"));
      await request(["PAL3", "FLA3", "FLA3"], "score");
      expect((await requests("FLA3")).map((r) => [r.reason, r.requestedAt, r.doneAt])).toEqual([["score", brt("2027-04-06", "18:40"), null]]);
      expect((await requests("PAL3")).map((r) => r.reason)).toEqual(["score"]);
      expect(waker.calls).toEqual([{ seasonId, tickers: ["FLA3", "PAL3"], reason: "score" }]);

      // desfeita: nenhuma linha e ninguém acordado
      await expect(
        withTransaction(db, async (tx) => {
          await refresher.requestRefresh(tx, ["SPT3"], "correction");
          throw new Error("desfaz");
        }),
      ).rejects.toThrow("desfaz");
      expect(await requests("SPT3")).toEqual([]);
      expect(waker.calls).toHaveLength(1);

      // nada pedido, nada gravado; clube que não está na temporada é erro
      await request([]);
      expect(waker.calls).toHaveLength(1);
      await expect(request(["COR3"])).rejects.toThrow(/não listado/);

      // o inscrito que falha não segura os outros nem quem pediu; quem desfaz a inscrição não é mais chamado
      const off = waker.waker.onWake(() => {
        throw new Error("tarefa fora do ar");
      });
      await request(["SPT3"], "close");
      expect(waker.calls.at(-1)).toEqual({ seasonId, tickers: ["SPT3"], reason: "close" });
      expect((await requests("SPT3")).map((r) => r.reason)).toEqual(["close"]);
      off();
      await request(["SPT3"], "resume");
      expect(waker.calls).toHaveLength(3);
    }),
  );

  it(
    "a reposição atende só os pedidos que leu antes do valor justo: o placar que entra no meio dela pede outra",
    scene(async () => {
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      await ready();
      await request(["FLA3"], "score");

      const r = refreshed(
        await refresh("FLA3", 4200, NOW, {
          // com o clube travado, outro placar do FLA3 é importado (o pedido não trava o clube)
          afterClubLock: async () => {
            await db.insert(marketRefreshRequests).values({ seasonId, clubId: club("FLA3"), reason: "correction", requestedAt: NOW });
          },
        }),
      );
      expect(r.requestsDone).toBe(1);
      expect((await requests("FLA3")).map((x) => [x.reason, x.doneAt])).toEqual([
        ["score", NOW],
        ["correction", null],
      ]);
      const open = await db
        .select()
        .from(marketRefreshRequests)
        .where(and(eq(marketRefreshRequests.clubId, club("FLA3")), isNull(marketRefreshRequests.doneAt)));
      expect(open).toHaveLength(1);
    }),
  );

  it(
    "sem o valor justo pronto, a reposição o calcula pelo FairValueService, fora da transação",
    scene(async () => {
      const values = new SeasonValuesService(db);
      await withTransaction(db, (tx) => values.createInitial(tx, seasonId));
      // o calendário do Brasileirão entre os três clubes listados, ainda sem resultado
      for (const [round, home, away] of [
        [1, "FLA3", "PAL3"],
        [2, "PAL3", "SPT3"],
        [3, "SPT3", "FLA3"],
      ] as const) {
        await insertMatch(db, { seasonId, homeClubId: club(home), awayClubId: club(away), kickoff: later(NOW, round * 7 * 24 * HOUR), round });
      }
      const fairValues = new FairValueService(db, values);
      const own = new RefreshService(db, service, cancels, fairValues, clock, undefined, undefined, undefined);
      await stock(RICH, { FLA3: 600 });
      await holder("FLA3", 2_400);
      await ready();

      const fair = (await fairValues.compute(seasonId, NOW)).get("FLA3")!;
      const r = refreshed(await own.refreshClub(seasonId, "FLA3", NOW));
      expect(r.fairValue).toBe(fair);
      expect(r.quote).toEqual(computeQuote(Math.max(50, fair), false, RICH, 600, DEFAULT_MARKET_MAKER, { quantity: 10, displayedPrice: 4000 }));
    }),
  );
});

describe("reposição da casa na aplicação", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(NOW);
  let app: NestFastifyApplication;
  let bus: EventBus;
  let seasonId: number;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    bus = app.get(EventBus, { strict: false });
    const s = await marketSeason(database.db, { tickers: TICKERS });
    seasonId = s.seasonId;
    const treasury = await openTreasury(database.db, seasonId, RICH);
    await giveShares(database.db, treasury, s.clubIds.get("FLA3")!, 600);
    await syncTotalShares(database.db, seasonId);
  });
  afterAll(() => app?.close());

  it("o app liga o RefreshService ao motor de ordens, ao cancelamento e aos eventos: depois do COMMIT saem o modo de jogo e o livro", async () => {
    const refresher = app.get(RefreshService);
    expect(refresher).toBeInstanceOf(RefreshService);
    expect(app.get(FairValueService)).toBeInstanceOf(FairValueService);
    const got: BusEvent[] = [];
    bus.subscribe("club:FLA3", (e) => got.push(e));

    const r = refreshed(await refresher.refreshClub(seasonId, "FLA3", NOW, { fairValues: new Map([["FLA3", 4200]]) }));
    expect(r.quote).toEqual({ bid: { price: 3990, quantity: 10 }, ask: { price: 4410, quantity: 10 } });
    await app.get(BookPublisher).idle();
    // o barramento limita `book` a 4 por segundo: o último de uma rajada sai no fim da janela
    await sleep(1_100);
    const frames = got.map((e) => JSON.parse(e.frame) as { type: string; data: Record<string, unknown> });
    expect(frames.filter((f) => f.type === "match_mode").map((f) => f.data)).toEqual([{ active: false }]);
    const book = frames.filter((f) => f.type === "book").at(-1)!.data as { bids: { price: number }[]; asks: { price: number }[] };
    expect(book.bids[0]).toMatchObject({ price: 3990, quantity: 10 });
    expect(book.asks[0]).toMatchObject({ price: 4410, quantity: 10 });

    // o pedido gravado pela aplicação acorda quem se inscreveu no RefreshWaker do app (a T11, na subida)
    const woken: RefreshWakeUp[] = [];
    const off = app.get(RefreshWaker).onWake((request) => {
      woken.push(request);
    });
    await withTransaction(database.db, (tx) => refresher.requestRefresh(tx, ["FLA3"], "resume"));
    off();
    expect(woken).toEqual([{ seasonId, tickers: ["FLA3"], reason: "resume" }]);
    const pending = await database.db.select().from(marketRefreshRequests).where(isNull(marketRefreshRequests.doneAt));
    expect(pending.map((p) => p.reason)).toEqual(["resume"]);
  });
});
