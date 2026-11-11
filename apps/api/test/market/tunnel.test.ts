import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/infra/db/client.js";
import { DB, lockClubs, type Tx, withTransaction } from "../../src/infra/db/index.js";
import { seasonClubs, trades } from "../../src/infra/db/schema/index.js";
import {
  AuctionCloser,
  auctionExpired,
  displayedPrice,
  isAuctionExpired,
  isInAuction,
  MatchingEngine,
  OrderService,
  rebuildTunnelReference,
  type PlaceOrderAttempt,
  type PlaceOrderInput,
  type PostgresMatchingEngine,
} from "../../src/modules/market/index.js";
import { useTestDatabase } from "../support/db.js";
import { totalCash } from "../support/invariants.js";
import { insertTrade, marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  clubRow,
  giveCash,
  giveShares,
  openPlayer,
  openTreasury,
  orderInputs,
  orderRow,
  orderService,
  positionOf,
  rejected,
  rolledBack,
  rowCounts,
  setTunnelState,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// L4 do Plano do livro de ofertas e formador: a ordem com o túnel de preço e a abertura do leilão, pelo serviço, no
// banco (Livro de ofertas e formador de mercado, "Túnel de preço e leilão", critérios 39, 41, 43 e 44). O fim do
// leilão (critérios 40 e 42) é da L5; a suspensão durante o leilão (45), da L7.

/** Um instante pelo relógio de Brasília. */
const brt = (day: string, time: string) => new Date(`${day}T${time}:00-03:00`);
/** Terça, 6 de abril de 2027: a ordem do critério 39 chega às 12h40 e o leilão vai até as 15h40. */
const T1240 = brt("2027-04-06", "12:40");
const T1540 = brt("2027-04-06", "15:40");
const TODAY = brt("2027-04-06", "00:00");
const TICKERS = ["FLA3", "PAL3", "SPT3"];
const RICH = 10_000_000;

describe("ordem com túnel de preço e abertura do leilão", () => {
  const t = useTestDatabase(5);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let service: OrderService;
  let engine: PostgresMatchingEngine;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number | undefined;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  /** Cada teste numa transação desfeita no fim, com as invariantes conferidas antes (como em `place-order.test.ts`). */
  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      treasury = await openTreasury(db, seasonId);
      ({ service, engine } = orderService(db));
      o = orderInputs({ seasonId, now: T1240 });
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
  const ready = async () => {
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  };
  const row = (ticker: string) => clubRow(db, seasonId, club(ticker));
  const tradesOf = (ticker: string) => db.select().from(trades).where(eq(trades.clubId, club(ticker))).orderBy(asc(trades.id));

  /**
   * O livro do critério 39, montado às 12h30: FLA3 com referência e preço exibido em R$ 40,00 (túnel de R$ 36,00 a
   * R$ 44,00), a casa sem venda, e as vendas de Bruno (50 a R$ 43,00) e de Davi (100 a R$ 44,50). Fecha a montagem:
   * as outras carteiras do teste são abertas antes.
   */
  const book39 = async () => {
    const bruno = await holder("FLA3", 50);
    const davi = await holder("FLA3", 100);
    const ana = await player(1_000_000);
    await ready();
    const at1230 = { now: brt("2027-04-06", "12:30") };
    const ofBruno = accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4300, at1230)));
    const ofDavi = accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4450, at1230)));
    return { ana, bruno, davi, ofBruno, ofDavi };
  };

  // ------------------------------------------------------------------ critérios da especificação

  it("livro 39: às 12h40 a compra de 100 a R$ 45,00 não executa nada, abre o leilão até 15h40 e entra inteira nele com R$ 4.500,00 reservados; o preço exibido continua R$ 40,00", scene(async () => {
    const { ana, ofBruno, ofDavi } = await book39();
    const before = await rowCounts(db);

    const r = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500)));

    // 50 sairiam a R$ 43,00, dentro do túnel, e 50 a R$ 44,50, fora: nenhuma sai
    expect(r.trades).toEqual([]);
    expect(r.openedAuction).toBe(true);
    expect(r.auction).toEqual({ until: T1540 });
    expect(r.order).toMatchObject({ status: "open", quantity: 100, filled: 0, limitPrice: 4500, reservedCash: 450_000 });
    expect(r.cash).toEqual({ total: 1_000_000, reserved: 450_000, free: 550_000 });
    expect(r.posts.map((p) => [p.entry.kind, p.entry.reservedCashDelta])).toEqual([["order_reserve", 450_000]]);
    expect(r.club).toMatchObject({ price: 4000, priceBefore: 4000 });
    expect(await walletOf(db, ana)).toEqual({ cash: 1_000_000, reservedCash: 450_000, free: 550_000, openOrders: 1 });
    const fla = await row("FLA3");
    expect(fla).toMatchObject({ lastPrice: 4000, lastTradeAt: null, auctionOpenedAt: T1240, auctionUntil: T1540, tunnelRef: 4000, tunnelRefDay: TODAY });
    expect(isInAuction(fla)).toBe(true);
    expect(await rowCounts(db)).toEqual({ orders: before.orders + 1, trades: before.trades, entries: before.entries + 1 });
    // as vendas de Bruno e de Davi continuam inteiras no livro, que agora aparece cruzado
    expect(await orderRow(db, ofBruno.order.id)).toMatchObject({ status: "open", filled: 0 });
    expect(await orderRow(db, ofDavi.order.id)).toMatchObject({ status: "open", filled: 0 });
  }));

  it("livro 39: em vez disso, a compra de 50 a R$ 44,00 compra 50 de Bruno a R$ 43,00 na hora, sem leilão", scene(async () => {
    const { ana, bruno } = await book39();

    const r = accepted(await service.place(o.buyLimit(ana, "FLA3", 50, 4400)));

    expect(r.trades.map((x) => [x.sellerWalletId, x.quantity, x.price, x.inAuction])).toEqual([[bruno, 50, 4300, false]]);
    expect(r.openedAuction).toBe(false);
    expect(r.auction).toBeNull();
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4300, auctionOpenedAt: null, auctionUntil: null, tunnelRef: 4000 });
  }));

  it("livro 41: com o FLA3 em leilão, a compra a mercado dá club_in_auction e a limitada a R$ 48,01 é recusada pelo limite de 20%; a limitada dentro da faixa entra no leilão sem casar, mesmo cruzando o livro", scene(async () => {
    const carla = await player();
    const eva = await holder("FLA3", 20);
    const { ana } = await book39();
    accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500)));
    const before = await rowCounts(db);
    const at13 = { now: brt("2027-04-06", "13:00") };

    expect(rejected(await service.place(o.buyMarket(carla, "FLA3", 10, undefined, at13)))).toEqual({ ok: false, code: "club_in_auction" });
    expect(rejected(await service.place(o.sellMarket(eva, "FLA3", 10, undefined, at13))).code).toBe("club_in_auction");
    expect(rejected(await service.place(o.buyLimit(carla, "FLA3", 10, 4801, at13))).code).toBe("price_out_of_band");
    expect(await rowCounts(db)).toEqual(before);

    // critério 40: Carla põe no leilão uma compra de 30 a R$ 42,00
    const bid = accepted(await service.place(o.buyLimit(carla, "FLA3", 30, 4200, at13)));
    expect(bid).toMatchObject({ trades: [], openedAuction: false, auction: { until: T1540 } });
    // a compra a R$ 46,00 alcançaria as vendas de Bruno e de Davi, e a venda a R$ 40,00 alcançaria as três compras:
    // em leilão nenhuma casa, e as duas entram inteiras, com a reserva
    const crossBuy = accepted(await service.place(o.buyLimit(carla, "FLA3", 10, 4600, at13)));
    expect(crossBuy.trades).toEqual([]);
    expect(crossBuy.order).toMatchObject({ status: "open", filled: 0, reservedCash: 46_000 });
    const crossSell = accepted(await service.place(o.sellLimit(eva, "FLA3", 10, 4000, at13)));
    expect(crossSell.trades).toEqual([]);
    expect(crossSell.order).toMatchObject({ status: "open", filled: 0 });
    expect(await positionOf(db, eva, club("FLA3"))).toEqual({ shares: 20, reservedShares: 10, free: 10 });
    expect(await walletOf(db, carla)).toMatchObject({ reservedCash: 30 * 4200 + 46_000, openOrders: 2 });

    // nenhum negócio, o preço exibido parado e o fim do leilão no mesmo lugar: o leilão não se prorroga
    expect(await tradesOf("FLA3")).toHaveLength(0);
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4000, auctionOpenedAt: T1240, auctionUntil: T1540 });
    // (a terceira parte do critério, cancelar a ordem do leilão e a reserva voltar, é do cancelamento: T6)
  }));

  it("livro 43: as duas ordens de 1 SPT3 a R$ 8,40 às 21h30 abrem o leilão até 0h30, e o preço exibido às 23h59 continua R$ 7,00", scene(async () => {
    const bruno = await holder("SPT3", 1);
    const ana = await player();
    await setTunnelState(db, seasonId, club("SPT3"), { lastPrice: 700, ipoPrice: 700 });
    await ready();
    const at2130 = { now: brt("2027-07-31", "21:30") };

    // a venda de Bruno entra no livro: fora do túnel (R$ 6,30 a R$ 7,70), mas dentro dos 20%, e não executa nada
    expect(accepted(await service.place(o.sellLimit(bruno, "SPT3", 1, 840, at2130)))).toMatchObject({ openedAuction: false, auction: null });
    const r = accepted(await service.place(o.buyLimit(ana, "SPT3", 1, 840, at2130)));

    expect(r.trades).toEqual([]);
    expect(r.openedAuction).toBe(true);
    expect(r.auction).toEqual({ until: brt("2027-08-01", "00:30") });
    expect(await row("SPT3")).toMatchObject({ lastPrice: 700, tunnelRef: 700, tunnelRefDay: brt("2027-07-31", "00:00"), auctionUntil: brt("2027-08-01", "00:30") });
    // o ranking de julho fecha às 23h59 com o SPT3 a R$ 7,00
    expect(await displayedPrice(db, seasonId, "SPT3", brt("2027-07-31", "23:59"))).toBe(700);
    expect(await displayedPrice(db, seasonId, "SPT3")).toBe(700);
  }));

  it("livro 44: quando o dia vira, a referência do FLA3 passa a R$ 44,50, o preço exibido às 0h, e a do PAL3, em leilão desde a véspera, continua R$ 30,00", scene(async () => {
    const [seller, buyer] = [await holder("PAL3", 2), await player()];
    const [fla, other] = [await holder("FLA3", 10), await player()];
    // O FLA3 como ficou na véspera, com o preço exibido em R$ 44,50 (o fim do leilão que o levou lá é da L5) e a
    // referência ainda do dia 6; o PAL3 com o preço exibido em R$ 30,00.
    await setTunnelState(db, seasonId, club("FLA3"), { lastPrice: 4450, tunnelRef: 4000, tunnelRefDay: TODAY });
    await setTunnelState(db, seasonId, club("PAL3"), { lastPrice: 3000 });
    await ready();
    // PAL3: às 23h do dia 6 a compra a R$ 34,00 sairia do túnel (R$ 27,00 a R$ 33,00) e abre o leilão até as 2h
    const at23 = { now: brt("2027-04-06", "23:00") };
    accepted(await service.place(o.sellLimit(seller, "PAL3", 1, 3400, at23)));
    expect(accepted(await service.place(o.buyLimit(buyer, "PAL3", 1, 3400, at23))).openedAuction).toBe(true);

    const at0030 = { now: brt("2027-04-07", "00:30") };
    // FLA3: a primeira ordem do dia 7 vira a referência para R$ 44,50; o túnel novo vai de R$ 40,05 a R$ 48,95
    accepted(await service.place(o.sellLimit(fla, "FLA3", 10, 4895, at0030)));
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4450, tunnelRefDay: brt("2027-04-07", "00:00") });
    const r = accepted(await service.place(o.buyLimit(other, "FLA3", 10, 4895, at0030)));
    expect(r.trades.map((x) => x.price)).toEqual([4895]);
    expect(r.openedAuction).toBe(false);

    // PAL3: em leilão às 0h, mantém a referência de R$ 30,00 e o dia dela até o leilão acabar
    expect(accepted(await service.place(o.sellLimit(seller, "PAL3", 1, 3300, at0030))).auction).toEqual({ until: brt("2027-04-07", "02:00") });
    expect(await row("PAL3")).toMatchObject({ tunnelRef: 3000, tunnelRefDay: TODAY, lastPrice: 3000 });
  }));

  // ------------------------------------------------------------------ a referência e o túnel

  it("a referência vira no primeiro negócio do dia novo e só uma vez por dia: de R$ 40,00 o preço vai a R$ 44,00 hoje e a R$ 48,00 amanhã; R$ 48,50 no mesmo dia abre o leilão", scene(async () => {
    const bruno = await holder("FLA3", 30);
    const carla = await player();
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4400)));
    expect(accepted(await service.place(o.buyLimit(carla, "FLA3", 10, 4400))).trades.map((x) => x.price)).toEqual([4400]);
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4000, tunnelRefDay: TODAY, lastPrice: 4400 });

    const tomorrow = { now: brt("2027-04-07", "09:00") };
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4800, tomorrow)));
    const r = accepted(await service.place(o.buyLimit(carla, "FLA3", 10, 4800, tomorrow)));
    expect(r.trades.map((x) => x.price)).toEqual([4800]);
    expect(r.openedAuction).toBe(false);
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4400, tunnelRefDay: brt("2027-04-07", "00:00"), lastPrice: 4800 });

    // a referência não segue o negócio a R$ 48,00: continua R$ 44,00 (túnel até R$ 48,40) até as 0h seguintes
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4850, tomorrow)));
    const breach = accepted(await service.place(o.buyLimit(carla, "FLA3", 10, 4850, tomorrow)));
    expect(breach).toMatchObject({ trades: [], openedAuction: true, auction: { until: brt("2027-04-07", "12:00") } });
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4400, lastPrice: 4800 });
  }));

  it("o que executaria dentro do túnel segue normal, e a venda também abre o leilão: a compra de 100 a R$ 45,00 leva as 50 a R$ 43,00 e deixa 50 no livro; a venda que alcançaria essa sobra a R$ 45,00 abre o leilão", scene(async () => {
    const [bruno, eva] = [await holder("FLA3", 50), await holder("FLA3", 10)];
    const ana = await player(1_000_000);
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4300)));

    const buy = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500)));
    expect(buy.trades.map((x) => [x.quantity, x.price])).toEqual([[50, 4300]]);
    expect(buy).toMatchObject({ openedAuction: false, auction: null });
    expect(buy.order).toMatchObject({ status: "open", filled: 50, reservedCash: 50 * 4500 });

    // o negócio sairia pelo preço da ordem que está no livro, R$ 45,00, acima dos R$ 44,00 do túnel
    const sell = accepted(await service.place(o.sellLimit(eva, "FLA3", 10, 4450)));
    expect(sell).toMatchObject({ trades: [], openedAuction: true, auction: { until: T1540 } });
    expect(sell.order).toMatchObject({ status: "open", filled: 0 });
    expect(await positionOf(db, eva, club("FLA3"))).toEqual({ shares: 10, reservedShares: 10, free: 0 });
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4300, auctionOpenedAt: T1240 });
  }));

  it("a ordem a mercado para no túnel e não abre leilão: o que passaria dele é cancelado (D1)", scene(async () => {
    const [bruno, davi] = [await holder("FLA3", 50), await holder("FLA3", 50)];
    const [carla, eva] = [await player(), await player()];
    const ana = await holder("FLA3", 100);
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4300)));
    accepted(await service.place(o.sellLimit(davi, "FLA3", 50, 4450)));

    // R$ 44,50 cabe nos 20% (até R$ 48,00), mas passa do túnel (até R$ 44,00)
    const buy = accepted(await service.place(o.buyMarket(ana, "FLA3", 100)));
    expect(buy.trades.map((x) => [x.quantity, x.price])).toEqual([[50, 4300]]);
    expect(buy.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", filled: 50 });
    expect(buy).toMatchObject({ openedAuction: false, auction: null });

    // na venda, o piso é o do túnel (R$ 36,00): a compra a R$ 35,50 fica de fora
    accepted(await service.place(o.buyLimit(carla, "FLA3", 50, 3700)));
    accepted(await service.place(o.buyLimit(eva, "FLA3", 50, 3550)));
    const sell = accepted(await service.place(o.sellMarket(ana, "FLA3", 100)));
    expect(sell.trades.map((x) => [x.quantity, x.price])).toEqual([[50, 3700]]);
    expect(sell.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", filled: 50 });
    expect(isInAuction(await row("FLA3"))).toBe(false);
  }));

  it("D1: a ordem a mercado cuja primeira oferta está do OUTRO lado do túnel não executa nada, não abre leilão e não dá erro (achado do stress da T16)", scene(async () => {
    const bruno = await holder("FLA3", 50);
    const carla = await player();
    const ana = await holder("PAL3", 100);
    const davi = await player();
    await ready();
    // uma limitada fora do túnel (R$ 36,00 a R$ 44,00) mas dentro dos 20%: fica aberta no livro
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 3550)));
    const buy = accepted(await service.place(o.buyMarket(davi, "FLA3", 5)));
    expect(buy.trades).toEqual([]);
    expect(buy.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", filled: 0 });
    expect(buy).toMatchObject({ openedAuction: false, auction: null });
    expect(isInAuction(await row("FLA3"))).toBe(false);
    // o simétrico, noutro clube: uma compra parada acima do teto, e a venda a mercado não a alcança
    accepted(await service.place(o.buyLimit(carla, "PAL3", 10, 4450)));
    const sell = accepted(await service.place(o.sellMarket(ana, "PAL3", 5)));
    expect(sell.trades).toEqual([]);
    expect(sell.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", filled: 0 });
    expect(isInAuction(await row("PAL3"))).toBe(false);
  }));

  it("a cotação da casa que executaria fora do túnel abre o leilão e entra nele (D2); a ordem a mercado da casa também para no túnel", scene(async () => {
    await giveCash(db, treasury, 1_000_000);
    const davi = await holder("FLA3", 10);
    await ready();
    accepted(await service.place(o.sellLimit(davi, "FLA3", 10, 4450)));
    const house = { actor: "house" as const };

    // a casa não tem a faixa de 20%, mas a ordem a mercado dela não passa do túnel
    const market = accepted(await service.place(o.buyMarket(treasury, "FLA3", 10, undefined, house)));
    expect(market.trades).toEqual([]);
    expect(market.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder" });
    expect(market.openedAuction).toBe(false);

    const quote = accepted(await service.place(o.buyLimit(treasury, "FLA3", 10, 4500, house)));
    expect(quote).toMatchObject({ trades: [], openedAuction: true, auction: { until: T1540 } });
    expect(quote.order).toMatchObject({ status: "open", filled: 0, reservedCash: 45_000 });
    expect(await walletOf(db, treasury)).toEqual({ cash: 1_000_000, reservedCash: 45_000, free: 955_000, openOrders: 1 });
  }));

  // ------------------------------------------------------------------ recusas

  it("a ordem recusada não abre leilão: sem caixa, a 51ª ordem aberta e a ordem contra si mesmo", scene(async () => {
    const [poor, busy, ana] = [await player(100_000), await player(), await player()];
    const davi = await holder("FLA3", 100);
    await ready();
    accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4450)));
    for (let i = 0; i < 50; i++) accepted(await service.place(o.buyLimit(busy, "PAL3", 1, 3600 + i)));
    const before = await rowCounts(db);

    // as três alcançariam a venda de Davi a R$ 44,50, fora do túnel
    expect(rejected(await service.place(o.buyLimit(poor, "FLA3", 100, 4500))).code).toBe("insufficient_cash");
    expect(rejected(await service.place(o.buyLimit(busy, "FLA3", 10, 4500))).code).toBe("too_many_open_orders");
    expect(rejected(await service.place(o.buyLimit(davi, "FLA3", 10, 4500))).code).toBe("self_trade");
    expect(await rowCounts(db)).toEqual(before);
    expect(await row("FLA3")).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });

    // a mesma ordem, de quem pode mandá-la, abre
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4500))).openedAuction).toBe(true);
  }));

  it("a ordem contra si mesmo continua recusada no leilão", scene(async () => {
    const davi = await holder("FLA3", 100);
    const ana = await holder("FLA3", 20, 1_000_000);
    await ready();
    accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4450)));
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500))).openedAuction).toBe(true);
    const before = await rowCounts(db);

    // Davi tem a venda a R$ 44,50 e Ana a compra a R$ 45,00, as duas no leilão
    expect(rejected(await service.place(o.buyLimit(davi, "FLA3", 10, 4500)))).toEqual({ ok: false, code: "self_trade" });
    expect(rejected(await service.place(o.sellLimit(ana, "FLA3", 10, 4400))).code).toBe("self_trade");
    expect(await rowCounts(db)).toEqual(before);
    // a venda acima da própria compra não cruza com ela: entra
    expect(accepted(await service.place(o.sellLimit(ana, "FLA3", 10, 4600))).order.status).toBe("open");
  }));

  it("a primeira ordem do dia vira a referência do túnel mesmo recusada, e é só o que uma recusa grava; com o clube suspenso, nem isso", scene(async () => {
    const ana = await player();
    await ready();
    await db.update(seasonClubs).set({ suspendedReason: "Resultado em revisão" }).where(eq(seasonClubs.clubId, club("PAL3")));
    const before = await rowCounts(db);

    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4801))).code).toBe("price_out_of_band");
    expect(rejected(await service.place(o.buyLimit(ana, "PAL3", 1, 4000))).code).toBe("club_suspended");

    expect(await rowCounts(db)).toEqual(before);
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4000, tunnelRefDay: TODAY, auctionOpenedAt: null });
    expect(await row("PAL3")).toMatchObject({ tunnelRef: null, tunnelRefDay: null });
  }));

  // ------------------------------------------------------------------ leilão parado e leilão vencido

  it("o leilão parado pela suspensão recusa pela suspensão e não vence; retomado ainda sem fim marcado, a limitada entra sem casar e a de mercado continua recusada", scene(async () => {
    const carla = await player();
    const { ana } = await book39();
    accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500)));
    // a suspensão do clube para a contagem (L7): o leilão fica com o início e sem o fim
    await db.update(seasonClubs).set({ suspendedReason: "Resultado em revisão", auctionUntil: null }).where(eq(seasonClubs.clubId, club("FLA3")));
    const at16 = { now: brt("2027-04-06", "16:00") };

    expect(rejected(await service.place(o.buyLimit(carla, "FLA3", 1, 4200, at16)))).toEqual({ ok: false, code: "club_suspended", reason: "Resultado em revisão" });
    const paused = await row("FLA3");
    expect(isInAuction(paused)).toBe(true);
    expect(auctionExpired(paused, at16.now)).toBe(false);

    await db.update(seasonClubs).set({ suspendedReason: null }).where(eq(seasonClubs.clubId, club("FLA3")));
    const r = accepted(await service.place(o.buyLimit(carla, "FLA3", 1, 4600, at16)));
    expect(r).toMatchObject({ trades: [], openedAuction: false, auction: { until: null } });
    expect(rejected(await service.place(o.buyMarket(carla, "FLA3", 1, undefined, at16))).code).toBe("club_in_auction");
  }));

  it("o leilão vencido: às 15h39min59s a limitada ainda entra nele; às 15h40 a ordem sai sem gravar nada e avisa quem chama, e sem quem feche o leilão o place dá erro (P10)", scene(async () => {
    const carla = await player();
    const { ana } = await book39();
    accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500)));

    const lastSecond = { now: new Date(T1540.getTime() - 1_000) };
    expect(accepted(await service.place(o.buyLimit(carla, "FLA3", 1, 4200, lastSecond))).auction).toEqual({ until: T1540 });

    const snapshot = async () => ({ counts: await rowCounts(db), club: await row("FLA3"), carla: await walletOf(db, carla) });
    const before = await snapshot();
    const attempt = await withTransaction(db, (tx) => service.placeOrder(tx, o.buyLimit(carla, "FLA3", 1, 4200, { now: T1540 })));
    expect(attempt).toEqual({ ok: false, auctionExpired: true, seasonId, ticker: "FLA3", until: T1540 });
    expect(isAuctionExpired(attempt)).toBe(true);
    expect(await snapshot()).toEqual(before);

    // a ordem a mercado também não é recusada com "clube em leilão": o leilão acabou, falta fechá-lo
    const market = await withTransaction(db, (tx) => service.placeOrder(tx, o.buyMarket(carla, "FLA3", 1, undefined, { now: T1540 })));
    expect(isAuctionExpired(market)).toBe(true);

    // o fim do leilão é da L5: sem o AuctionCloser registrado, a ordem não entra no leilão vencido nem é recusada
    await expect(service.place(o.buyLimit(carla, "FLA3", 1, 4200, { now: T1540 }))).rejects.toThrow(/AuctionCloser/);
    expect(await snapshot()).toEqual(before);
  }));

  it("com quem feche o leilão, a ordem que o encontra vencido fecha antes e é mandada de novo, uma vez só", scene(async () => {
    const bruno = await holder("FLA3", 10);
    const ana = await player();
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4300, { now: brt("2027-04-06", "12:30") })));
    // um leilão vencido sem ordens cruzadas (como no critério 42, em que quem o abriu cancelou): fecha sem negócio
    const expired = { auctionOpenedAt: T1240, auctionUntil: T1540 };
    await setTunnelState(db, seasonId, club("FLA3"), expired);

    const calls: Array<[number, string, Date]> = [];
    class NoTradeCloser extends AuctionCloser {
      async closeAuction(season: number, ticker: string, now: Date): Promise<void> {
        calls.push([season, ticker, now]);
        // o que o fim do leilão sem negócio faz: limpa o leilão, e a referência fica
        await setTunnelState(db, season, club(ticker), { auctionOpenedAt: null, auctionUntil: null });
      }
    }
    const twoSecondsLater = { now: new Date(T1540.getTime() + 2_000) };
    const r = accepted(await new OrderService(db, engine, new NoTradeCloser()).place(o.buyLimit(ana, "FLA3", 10, 4300, twoSecondsLater)));

    expect(calls).toEqual([[seasonId, "FLA3", twoSecondsLater.now]]);
    expect(r.trades.map((x) => [x.quantity, x.price, x.at])).toEqual([[10, 4300, twoSecondsLater.now]]);
    expect(r).toMatchObject({ openedAuction: false, auction: null });

    // quem não fecha de verdade não prende a ordem num laço: uma tentativa de fechar, e erro
    await setTunnelState(db, seasonId, club("FLA3"), expired);
    class StuckCloser extends AuctionCloser {
      calls = 0;
      async closeAuction(): Promise<void> {
        this.calls++;
      }
    }
    const stuck = new StuckCloser();
    await expect(new OrderService(db, engine, stuck).place(o.buyLimit(ana, "FLA3", 1, 4200, twoSecondsLater))).rejects.toThrow(/continua vencido/);
    expect(stuck.calls).toBe(1);
  }));

  it("a costura da L5: o Nest entrega ao OrderService o AuctionCloser registrado no módulo; sem registro, o serviço sobe sem ele", async () => {
    // um motor que encontra o leilão vencido na primeira tentativa e, depois de fechado, responde
    class ExpiredOnce extends MatchingEngine {
      attempts = 0;
      async place(_tx: Tx, input: PlaceOrderInput): Promise<PlaceOrderAttempt> {
        if (this.attempts++ === 0) return { ok: false, auctionExpired: true, seasonId: input.seasonId, ticker: input.ticker, until: T1540 };
        return { ok: false, code: "market_closed" };
      }
    }
    const closed: string[] = [];
    class Closer extends AuctionCloser {
      async closeAuction(_seasonId: number, ticker: string): Promise<void> {
        closed.push(ticker);
      }
    }
    const input = orderInputs({ seasonId, now: T1540 }).buyLimit(1, "FLA3", 1, 4000);
    const base = [OrderService, { provide: DB, useValue: t.db }, { provide: MatchingEngine, useClass: ExpiredOnce }];

    const wired = await Test.createTestingModule({ providers: [...base, { provide: AuctionCloser, useClass: Closer }] }).compile();
    expect(await wired.get(OrderService).place(input)).toEqual({ ok: false, code: "market_closed" });
    expect(closed).toEqual(["FLA3"]);

    const bare = await Test.createTestingModule({ providers: base }).compile();
    await expect(bare.get(OrderService).place(input)).rejects.toThrow(/AuctionCloser/);
    expect(closed).toEqual(["FLA3"]);
  });

  // ------------------------------------------------------------------ o que a F14 pediu

  it("isInAuction e auctionExpired: em leilão com ele aberto e com ele parado pela suspensão; só o leilão com fim marcado vence, e vence na hora do fim", () => {
    const open = { auctionOpenedAt: T1240, auctionUntil: T1540 };
    const paused = { auctionOpenedAt: T1240, auctionUntil: null };
    const none = { auctionOpenedAt: null, auctionUntil: null };
    expect([isInAuction(open), isInAuction(paused), isInAuction(none)]).toEqual([true, true, false]);
    expect(auctionExpired(open, new Date(T1540.getTime() - 1))).toBe(false);
    expect(auctionExpired(open, T1540)).toBe(true);
    expect(auctionExpired(paused, brt("2027-04-09", "12:00"))).toBe(false);
    expect(auctionExpired(none, T1540)).toBe(false);
  });

  it("rebuildTunnelReference: sem leilão hoje, volta ao preço exibido às 0h; com um leilão hoje, fica no preço dele", scene(async () => {
    const [buyer, seller] = [await player(), await player()];
    await ready();
    const fla = club("FLA3");
    const rebuild = (now: Date) =>
      withTransaction(db, async (tx) => {
        const [locked] = await lockClubs(tx, seasonId, ["FLA3"]);
        return rebuildTunnelReference(tx, locked!, now);
      });
    const trade = (at: Date, price: number, inAuction = false) =>
      insertTrade(db, { seasonId, clubId: fla, at, price, quantity: 1, buyerWalletId: buyer, sellerWalletId: seller, inAuction });
    const at10 = brt("2027-04-07", "10:00");
    const day7 = brt("2027-04-07", "00:00");

    // antes do primeiro negócio do clube, o preço exibido às 0h é o do IPO
    expect(await rebuild(at10)).toBe(4000);
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4000, tunnelRefDay: day7 });

    // ontem às 23h saiu negócio a R$ 42,00 e hoje às 9h a R$ 43,00: às 0h o preço exibido era R$ 42,00
    await trade(brt("2027-04-06", "23:00"), 4200);
    await trade(brt("2027-04-07", "09:00"), 4300);
    await setTunnelState(db, seasonId, fla, { tunnelRef: 9999, tunnelRefDay: brt("2027-04-01", "00:00") });
    expect(await rebuild(at10)).toBe(4200);
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4200, tunnelRefDay: day7 });

    // hoje às 9h30 fechou um leilão a R$ 44,50 e depois saiu um negócio comum a R$ 45,00: vale o preço do leilão
    await trade(brt("2027-04-07", "09:30"), 4450, true);
    await trade(brt("2027-04-07", "09:45"), 4500);
    expect(await rebuild(at10)).toBe(4450);
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4450, tunnelRefDay: day7 });

    // no dia seguinte o leilão de ontem não conta: sem leilão hoje, o preço exibido às 0h (o último negócio, R$ 45,00)
    expect(await rebuild(brt("2027-04-08", "08:00"))).toBe(4500);
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4500, tunnelRefDay: brt("2027-04-08", "00:00") });
  }));

  it("rebuildTunnelReference só com o clube travado e fora de leilão: em leilão a referência não muda", scene(async () => {
    await ready();
    await setTunnelState(db, seasonId, club("FLA3"), { tunnelRef: 4000, tunnelRefDay: TODAY, auctionOpenedAt: T1240, auctionUntil: null });

    await expect(
      withTransaction(db, async (tx) => {
        const [locked] = await lockClubs(tx, seasonId, ["FLA3"]);
        return rebuildTunnelReference(tx, locked!, T1540);
      }),
    ).rejects.toThrow(/em leilão/);
    const unlocked = await withTransaction(db, async (tx) => (await lockClubs(tx, seasonId, ["PAL3"]))[0]!);
    await expect(withTransaction(db, (tx) => rebuildTunnelReference(tx, unlocked, T1540))).rejects.toThrow(/não está travado/);
    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4000, tunnelRefDay: TODAY });
  }));
});
