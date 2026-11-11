import "reflect-metadata";
import { and, asc, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { dayStart, type Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { orders, trades } from "../../src/infra/db/schema/index.js";
import {
  AuctionCloser,
  CancelService,
  CloseAuctionAdapter,
  CloseAuctionService,
  OrderService,
  PostgresMatchingEngine,
  RefreshService,
  type AuctionClosed,
  type ClubRefreshed,
  type CloseAuctionResult,
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
  clubRow,
  giveShares,
  openPlayer,
  openTreasury,
  orderInputs,
  orderRow,
  rolledBack,
  setTunnelState,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// L6 do Plano do livro de ofertas e formador: a casa no leilão (Livro de ofertas e formador de mercado, "Túnel de preço
// e leilão", critério 40; D2; P10). A reposição repõe como sempre e, com o clube em leilão, as cotações entram nele sem
// casar; fora de leilão, a cotação que sairia do túnel abre o leilão; com o leilão vencido, a reposição fecha antes.
// No fim do arquivo, a reposição e o fim do leilão ao mesmo tempo, 50 repetições.

/** Um instante pelo relógio de Brasília. */
const brt = (day: string, time: string) => new Date(`${day}T${time}:00-03:00`);
const later = (at: Date, ms: number) => new Date(at.getTime() + ms);
const HOUR = 3_600_000;
const TODAY = brt("2027-04-06", "00:00");
const T1000 = brt("2027-04-06", "10:00");
const T1240 = brt("2027-04-06", "12:40");
const T1540 = brt("2027-04-06", "15:40");
const TICKERS = ["FLA3", "PAL3"];
const RICH = 10_000_000;

function refreshed(result: RefreshResult): ClubRefreshed {
  if (!result.refreshed) throw new Error(`a reposição devia cotar e não cotou: ${result.reason}`);
  return result;
}

function closed(result: CloseAuctionResult): AuctionClosed {
  if (!result.closed) throw new Error(`o leilão devia fechar e não fechou: ${result.reason}`);
  return result;
}

const fair = (ticker: string, value: Cents) => new Map([[ticker, value]]);
const noFairValue = { compute: async (): Promise<Map<string, Cents>> => new Map() };

describe("a casa no leilão", () => {
  const t = useTestDatabase(5);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let closer: CloseAuctionService;
  let service: OrderService;
  let refresher: RefreshService;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number | undefined;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      treasury = await openTreasury(db, seasonId, RICH);
      const ledger = new PortfolioLedger();
      closer = new CloseAuctionService(db, ledger);
      const adapter = new CloseAuctionAdapter(closer);
      service = new OrderService(db, new PostgresMatchingEngine(ledger), adapter);
      const cancels = new CancelService(db, ledger, adapter);
      refresher = new RefreshService(db, service, cancels, noFairValue, new FixedClock(T1000), adapter);
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
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  };
  const row = (ticker: string) => clubRow(db, seasonId, club(ticker));
  /** O preço exibido e a referência do túnel em R$ 40,00 hoje: o túnel vai de R$ 36,00 a R$ 44,00. */
  const at40 = (ticker: string) => setTunnelState(db, seasonId, club(ticker), { lastPrice: 4000, tunnelRef: 4000, tunnelRefDay: TODAY });
  const refresh = (ticker: string, now: Date, value = 4200) => refresher.refreshClub(seasonId, ticker, now, { fairValues: fair(ticker, value) });
  const houseQuotes = async (ticker: string) =>
    (
      await db
        .select({ side: orders.side, quantity: orders.quantity, filled: orders.filled, price: orders.limitPrice })
        .from(orders)
        .where(and(eq(orders.walletId, treasury), eq(orders.clubId, club(ticker)), eq(orders.status, "open")))
        .orderBy(asc(orders.side), asc(orders.id))
    ).map((r) => [r.side, r.quantity - r.filled, r.price]);
  const tradesOf = (ticker: string) => db.select().from(trades).where(eq(trades.clubId, club(ticker))).orderBy(asc(trades.id));

  it(
    "livro 40: a reposição das 15h põe a venda de 10 a R$ 44,10 no leilão sem casar, e ela entra no preço único de R$ 44,50 das 15h40",
    scene(async () => {
      const bruno = await holder("FLA3", 500);
      const davi = await holder("FLA3", 500);
      const ana = await openPlayer(db, seasonId, RICH);
      const carla = await openPlayer(db, seasonId, RICH);
      await holder("FLA3", 1_400);
      await ready();
      await at40("FLA3");

      // às 12h a casa só compra: a tesouraria ainda não tem FLA3
      refreshed(await refresh("FLA3", brt("2027-04-06", "12:00")));
      expect(await houseQuotes("FLA3")).toEqual([["buy", 10, 3990]]);
      // critério 39: Bruno vende 50 a R$ 43,00, Davi 100 a R$ 44,50, e a compra de Ana a R$ 45,00 abre o leilão até 15h40
      const brunoSale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4300, { now: brt("2027-04-06", "12:10") })));
      const daviSale = accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4450, { now: brt("2027-04-06", "12:20") })));
      const anaBuy = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500, { now: T1240 })));
      expect(anaBuy).toMatchObject({ openedAuction: true, auction: { until: T1540 }, trades: [] });
      const carlaBuy = accepted(await service.place(o.buyLimit(carla, "FLA3", 30, 4200, { now: brt("2027-04-06", "13:00") })));
      // as ações chegam à tesouraria antes das 15h (a casa sem venda no livro até lá)
      await giveShares(db, treasury, club("FLA3"), 600);
      await syncTotalShares(db, seasonId);

      // 15h: a reposição cancela a compra velha e põe as duas cotações no leilão; nada executa, mesmo com o livro cruzado
      const r = refreshed(await refresh("FLA3", brt("2027-04-06", "15:00")));
      expect(r).toMatchObject({ trades: [], openedAuction: false, closedAuction: false, auction: { until: T1540 } });
      expect(r.cancelled.map((c) => [c.side, c.cancelReason])).toEqual([["buy", "house_refresh"]]);
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 10, 4410],
      ]);
      expect(await orderRow(db, anaBuy.order.id)).toMatchObject({ status: "open", filled: 0, reservedCash: 450_000 });
      expect(await tradesOf("FLA3")).toEqual([]);
      expect((await row("FLA3")).lastPrice).toBe(4000);

      // 15h40: o preço único de R$ 44,50 com 100 ações; Ana compra 50 de Bruno, 10 da casa e 40 de Davi
      const end = closed(await closer.closeAuction(seasonId, "FLA3", T1540));
      expect(end).toMatchObject({ price: 4450, volume: 100 });
      expect((await tradesOf("FLA3")).map((x) => [x.sellOrderId, x.quantity, x.price, x.withHouse, x.inAuction])).toEqual([
        [brunoSale.order.id, 50, 4450, false, true],
        [r.ask!.order.id, 10, 4450, true, true],
        [daviSale.order.id, 40, 4450, false, true],
      ]);
      // Ana pagou R$ 4.450,00 e recebeu R$ 50,00 de volta da reserva
      expect(await walletOf(db, ana)).toMatchObject({ cash: RICH - 445_000, reservedCash: 0 });
      // as 60 de Davi, a compra de Carla e a compra da casa ficam no livro; preço exibido e referência em R$ 44,50
      expect(await orderRow(db, daviSale.order.id)).toMatchObject({ status: "open", filled: 40 });
      expect(await orderRow(db, carlaBuy.order.id)).toMatchObject({ status: "open", filled: 0 });
      expect(await houseQuotes("FLA3")).toEqual([["buy", 10, 3990]]);
      expect(await row("FLA3")).toMatchObject({ lastPrice: 4450, tunnelRef: 4450, auctionOpenedAt: null, auctionUntil: null });
    }),
  );

  it(
    "D2: a cotação da casa que executaria fora do túnel não executa, abre o leilão de 3 horas e entra nele inteira",
    scene(async () => {
      await giveShares(db, treasury, club("FLA3"), 600);
      await giveShares(db, treasury, club("PAL3"), 600);
      const bruno = await holder("FLA3", 2_400);
      const carla = await holder("PAL3", 2_400);
      await ready();
      await at40("FLA3");
      await at40("PAL3");

      // FLA3: a compra de Bruno a R$ 45,00 ficou no livro; a venda nova da casa (R$ 44,10) negociaria a R$ 45,00, fora do túnel
      const brunoBuy = accepted(await service.place(o.buyLimit(bruno, "FLA3", 10, 4500)));
      const fla = refreshed(await refresh("FLA3", T1000));
      expect(fla).toMatchObject({ trades: [], openedAuction: true, auction: { until: later(T1000, 3 * HOUR) } });
      expect(fla.bid!.openedAuction).toBe(false);
      expect(fla.ask!).toMatchObject({ openedAuction: true, order: { status: "open", filled: 0, quantity: 10 } });
      expect(await row("FLA3")).toMatchObject({ auctionOpenedAt: T1000, auctionUntil: later(T1000, 3 * HOUR), lastPrice: 4000 });
      expect(await orderRow(db, brunoBuy.order.id)).toMatchObject({ status: "open", filled: 0 });

      // PAL3: a venda de Carla a R$ 35,00; a compra nova da casa (R$ 39,90) negociaria a R$ 35,00, abaixo do túnel. Ela
      // abre o leilão, e a venda da casa, colocada depois, já entra nele sem casar
      const carlaSale = accepted(await service.place(o.sellLimit(carla, "PAL3", 10, 3500)));
      const pal = refreshed(await refresh("PAL3", T1000));
      expect(pal).toMatchObject({ trades: [], openedAuction: true });
      expect(pal.bid!).toMatchObject({ openedAuction: true, order: { status: "open", filled: 0 } });
      expect(pal.ask!).toMatchObject({ openedAuction: false, auction: { until: later(T1000, 3 * HOUR) }, order: { status: "open" } });
      expect(await orderRow(db, carlaSale.order.id)).toMatchObject({ status: "open", filled: 0 });

      // no fim do leilão a venda da casa entra no preço único: Bruno compra as 10 dela a R$ 44,10
      const end = closed(await closer.closeAuction(seasonId, "FLA3", later(T1000, 3 * HOUR)));
      expect(end).toMatchObject({ price: 4410, volume: 10 });
      expect((await tradesOf("FLA3")).map((x) => [x.buyOrderId, x.sellOrderId, x.quantity, x.withHouse, x.inAuction])).toEqual([
        [brunoBuy.order.id, fla.ask!.order.id, 10, true, true],
      ]);
    }),
  );

  it(
    "com o leilão vencido e ainda não fechado, a reposição fecha o leilão antes (no horário dela) e cota depois dele",
    scene(async () => {
      await giveShares(db, treasury, club("FLA3"), 600);
      const bruno = await holder("FLA3", 500);
      const davi = await holder("FLA3", 500);
      await holder("FLA3", 1_400);
      const ana = await openPlayer(db, seasonId, RICH);
      await ready();
      await at40("FLA3");
      accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4300, { now: brt("2027-04-06", "12:10") })));
      accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4450, { now: brt("2027-04-06", "12:20") })));
      expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500, { now: T1240 })))).toMatchObject({ openedAuction: true });

      // 15h41: a tarefa de 5 em 5 segundos ainda não passou
      const T1541 = brt("2027-04-06", "15:41");
      const r = refreshed(await refresh("FLA3", T1541));
      expect(r).toMatchObject({ closedAuction: true, auction: null, openedAuction: false, trades: [] });
      // o leilão fechou a R$ 44,50 com o horário da reposição (P10), e a casa cotou em volta do preço novo
      expect((await tradesOf("FLA3")).map((x) => [x.quantity, x.price, x.inAuction, x.at])).toEqual([
        [50, 4450, true, T1541],
        [50, 4450, true, T1541],
      ]);
      expect(await row("FLA3")).toMatchObject({ lastPrice: 4450, tunnelRef: 4450, auctionOpenedAt: null, mmRefreshedAt: T1541 });
      expect(await houseQuotes("FLA3")).toEqual([
        ["buy", 10, 3990],
        ["sell", 10, 4410],
      ]);
      expect(r.bid!.order.createdAt).toEqual(T1541);
    }),
  );

  it(
    "em leilão sem a cotação velha, e sem caixa para a compra: a reposição põe só a venda no leilão",
    scene(async () => {
      await giveShares(db, treasury, club("FLA3"), 600);
      const bruno = await holder("FLA3", 2_400);
      await ready();
      // a tesouraria sem caixa livre: todo o caixa dela fica preso numa compra de PAL3
      await at40("PAL3");
      const treasuryCash = (await walletOf(db, treasury)).free;
      accepted(await service.place({ ...o.buyLimit(treasury, "PAL3", Math.floor(treasuryCash / 3000), 3000), actor: "house" }));
      await setTunnelState(db, seasonId, club("FLA3"), { lastPrice: 4000, tunnelRef: 4000, tunnelRefDay: TODAY, auctionOpenedAt: T1000, auctionUntil: later(T1000, 3 * HOUR) });
      const brunoBuy = accepted(await service.place(o.buyLimit(bruno, "FLA3", 10, 4500, { now: later(T1000, HOUR) })));

      const r = refreshed(await refresh("FLA3", later(T1000, 2 * HOUR)));
      expect(r.quote.bid).toBeUndefined();
      expect(r).toMatchObject({ trades: [], cancelled: [], bid: null, auction: { until: later(T1000, 3 * HOUR) } });
      expect(await houseQuotes("FLA3")).toEqual([["sell", 10, 4410]]);
      expect(await orderRow(db, brunoBuy.order.id)).toMatchObject({ status: "open", filled: 0 });
    }),
  );
});

// ------------------------------------------------------------------------------------------- concorrência

const ROUNDS = 50;
/** Cada rodada ganha uma janela de 4 horas: o leilão abre no começo e termina 3 horas depois. */
const START = new Date("2027-04-07T03:00:00Z");
const SLOT_MS = 4 * HOUR;

describe("a reposição e o fim do leilão ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(30);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let closer: CloseAuctionService;
  let service: OrderService;
  let refresher: RefreshService;
  let o: ReturnType<typeof orderInputs>;
  let treasury: number;
  let ana: number, bruno: number;
  let cashBefore: number;
  let retries = 0;
  const transaction = { onRetry: () => retries++ };
  let slot = 0;

  beforeAll(async () => {
    db = t.db;
    ({ seasonId, clubIds } = await marketSeason(db, { tickers: ["FLA3"] }));
    const ledger = new PortfolioLedger();
    closer = new CloseAuctionService(db, ledger);
    const counted = new (class extends AuctionCloser {
      async closeAuction(season: number, ticker: string, now: Date): Promise<void> {
        await closer.closeAuction(season, ticker, now, { transaction });
      }
    })();
    service = new OrderService(db, new PostgresMatchingEngine(ledger), counted);
    const cancels = new CancelService(db, ledger, counted);
    refresher = new RefreshService(db, service, cancels, noFairValue, new FixedClock(START), counted);
    o = orderInputs({ seasonId, now: START });
    [bruno, ana] = (await openPlayerWallets(db, seasonId, 2, 50_000_000)) as [number, number];
    treasury = await openTreasury(db, seasonId, 50_000_000);
    await giveShares(db, treasury, club("FLA3"), 2_000);
    await giveShares(db, bruno, club("FLA3"), 1_000);
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const meeting = (late: string) => {
    const together = barrier(2);
    return (who: string) => async () => {
      await together();
      if (who === late) await sleep(3);
    };
  };
  const houseOpen = async () =>
    db
      .select({ id: orders.id, side: orders.side })
      .from(orders)
      .where(and(eq(orders.walletId, treasury), eq(orders.status, "open")))
      .orderBy(asc(orders.id));

  it("reposição e fim do leilão ao mesmo tempo: o leilão fecha uma vez, com a cotação velha ou a nova da casa, nunca as duas; nenhuma cotação velha sobra e a tesouraria se conserva (50 repetições)", async () => {
    const outcomes = { refreshInAuction: 0, refreshAfterClose: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const opened = new Date(START.getTime() + SLOT_MS * slot++);
      const until = later(opened, 3 * HOUR);
      await setTunnelState(db, seasonId, club("FLA3"), {
        lastPrice: 4000,
        tunnelRef: 4000,
        tunnelRefDay: new Date(dayStart(opened.getTime())),
        auctionOpenedAt: opened,
        auctionUntil: until,
      });
      const placed = { now: later(opened, HOUR) };
      const sale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 3900, placed), { transaction }));
      const purchase = accepted(await service.place(o.buyLimit(ana, "FLA3", 20, 4500, placed), { transaction }));
      // a casa repõe durante o leilão: compra a R$ 39,90 e venda a R$ 44,10 entram nele
      const during = refreshed(await refresher.refreshClub(seasonId, "FLA3", later(opened, 2 * HOUR), { fairValues: fair("FLA3", 4200), transaction }));
      expect(during.auction).toEqual({ until });
      const oldIds = [during.bid!.order.id, during.ask!.order.id];

      // a cada duas rodadas troca quem sai da barreira depois; a cada quatro, a reposição chega 1 ms antes do fim ou 1 s depois
      const meet = meeting(round % 2 === 0 ? "refresh" : "close");
      const beforeEnd = (round >> 1) % 2 === 1;
      const refreshAt = beforeEnd ? later(until, -1) : later(until, 1_000);
      const [, result] = (await Promise.all([
        closer.closeAuction(seasonId, "FLA3", until, { beforeClubLock: meet("close"), transaction }),
        refresher.refreshClub(seasonId, "FLA3", refreshAt, { fairValues: fair("FLA3", 4220), beforeClubLock: meet("refresh"), transaction }),
      ])) as [CloseAuctionResult, RefreshResult];
      const r = refreshed(result);

      // o leilão fechou uma vez: os dois negócios de Ana num preço e num horário só
      const auction = await db.select().from(trades).where(eq(trades.buyOrderId, purchase.order.id)).orderBy(asc(trades.id));
      expect(auction).toHaveLength(2);
      expect(auction.every((x) => x.inAuction)).toBe(true);
      expect(new Set(auction.map((x) => `${x.price}@${x.at.toISOString()}`)).size).toBe(1);
      expect(auction[0]).toMatchObject({ sellOrderId: sale.order.id, quantity: 10 });
      const house = auction[1]!;
      expect(house).toMatchObject({ withHouse: true, sellerWalletId: treasury, quantity: 10 });
      if (house.sellOrderId === oldIds[1]) {
        // o leilão fechou antes da reposição: a venda velha entrou no preço único (R$ 44,10); a reposição, já fora de
        // leilão, cancelou a compra velha e cotou em volta do preço novo
        outcomes.refreshAfterClose++;
        expect(house.price).toBe(4410);
        expect(r.auction).toBeNull();
        expect(r.cancelled.map((c) => c.id)).toEqual([oldIds[0]]);
        expect(r.trades).toEqual([]);
      } else {
        // a reposição chegou antes do fim: trocou as duas cotações dentro do leilão, e a venda nova (R$ 44,31) entrou no preço único
        outcomes.refreshInAuction++;
        expect(beforeEnd).toBe(true);
        expect(house.sellOrderId).toBe(r.ask!.order.id);
        expect(house.price).toBe(4431);
        expect(r).toMatchObject({ closedAuction: false, auction: { until }, trades: [] });
        expect(r.cancelled.map((c) => c.id).sort((a, b) => a - b)).toEqual(oldIds);
      }
      // nenhuma cotação velha sobra, nunca duas da casa no mesmo lado, e o leilão acabou
      expect((await db.select({ status: orders.status }).from(orders).where(inArray(orders.id, oldIds))).every((x) => x.status !== "open")).toBe(true);
      const open = await houseOpen();
      expect(open.filter((x) => x.side === "buy")).toHaveLength(1);
      expect(open.filter((x) => x.side === "sell").length).toBeLessThanOrEqual(1);
      expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
    expect(outcomes.refreshInAuction).toBeGreaterThan(0);
    expect(outcomes.refreshAfterClose).toBeGreaterThan(0);
  }, 240_000);
});
