import "reflect-metadata";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { clearAuction, type AuctionOrder } from "@futbolsa/engine";
import type { Database } from "../../src/infra/db/client.js";
import { candles, orders, seasonClubs, seasons, trades, walletEntries } from "../../src/infra/db/schema/index.js";
import {
  CancelService,
  CloseAuctionAdapter,
  CloseAuctionService,
  displayedPrice,
  OrderService,
  PostgresMatchingEngine,
  type AuctionClosed,
  type CloseAuctionResult,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { useTestDatabase } from "../support/db.js";
import { rng } from "../support/fixtures.js";
import {
  assertBookNotCrossed,
  assertLedgerConsistent,
  assertOpenOrdersCounter,
  assertReservesMatchOrders,
  assertSharesConserved,
  totalCash,
} from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  clubRow,
  giveShares,
  openOrderIds,
  openPlayer,
  openTreasury,
  orderInputs,
  orderRow,
  positionOf,
  rolledBack,
  rowCounts,
  setTunnelState,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// L5 do Plano do livro de ofertas e formador: o fim do leilão (`closeAuction`), pelo serviço, no banco (Livro de
// ofertas e formador de mercado, "Túnel de preço e leilão", critérios 40, 42 e 44; D4; P10). A tarefa de 5 em 5
// segundos, a costura no Nest e os eventos estão em `close-auction-job.test.ts`; as corridas, em
// `close-auction-concurrency.test.ts`.

/** Um instante pelo relógio de Brasília. */
const brt = (day: string, time: string) => new Date(`${day}T${time}:00-03:00`);
const later = (at: Date, ms: number) => new Date(at.getTime() + ms);
/** Terça, 6 de abril de 2027: o leilão do critério 39 abre às 12h40 e termina às 15h40. */
const T1240 = brt("2027-04-06", "12:40");
const T1540 = brt("2027-04-06", "15:40");
const TODAY = brt("2027-04-06", "00:00");
const TICKERS = ["FLA3", "PAL3", "SPT3"];
const RICH = 10_000_000;

/** O leilão fechou: devolve o resultado já com o tipo certo. */
function closed(result: CloseAuctionResult): AuctionClosed {
  if (!result.closed) throw new Error(`o leilão devia fechar e não fechou: ${result.reason}`);
  return result;
}

describe("fim do leilão", () => {
  const t = useTestDatabase(5);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let closer: CloseAuctionService;
  /** O serviço de ordens e o cancelamento com o fim do leilão ligado (P10), como o Nest os monta. */
  let service: OrderService;
  let cancels: CancelService;
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
      closer = new CloseAuctionService(db, ledger);
      const adapter = new CloseAuctionAdapter(closer);
      service = new OrderService(db, new PostgresMatchingEngine(ledger), adapter);
      cancels = new CancelService(db, ledger, adapter);
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
  const entriesOf = (walletId: number) => db.select().from(walletEntries).where(eq(walletEntries.walletId, walletId)).orderBy(asc(walletEntries.id));
  const clubWhere = (ticker: string) => and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club(ticker)));
  const at = (time: string, day = "2027-04-06") => ({ now: brt(day, time) });
  /** O que nenhuma chamada que não fecha o leilão pode mudar. */
  const snapshot = async (ticker: string) => ({ counts: await rowCounts(db), club: await row(ticker) });

  /**
   * O leilão dos critérios 39 e 40: FLA3 com referência e preço exibido em R$ 40,00; às 12h30 as vendas de Bruno (50
   * a R$ 43,00) e de Davi (100 a R$ 44,50); às 12h40 a compra de Ana (100 a R$ 45,00, R$ 4.500,00 reservados) abre o
   * leilão até 15h40; às 13h Carla põe uma compra de 30 a R$ 42,00 e, na reposição das 15h, a casa uma venda de 10 a
   * R$ 44,10, que entram no leilão sem casar. Fecha a montagem: as outras carteiras do teste são abertas antes.
   */
  const book40 = async () => {
    const bruno = await holder("FLA3", 50);
    const davi = await holder("FLA3", 100);
    const ana = await player(1_000_000);
    const carla = await player();
    await giveShares(db, treasury, club("FLA3"), 10);
    await ready();
    const ofBruno = accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4300, at("12:30"))));
    const ofDavi = accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4450, at("12:30"))));
    const ofAna = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500, at("12:40"))));
    expect(ofAna).toMatchObject({ openedAuction: true, auction: { until: T1540 } });
    const ofCarla = accepted(await service.place(o.buyLimit(carla, "FLA3", 30, 4200, at("13:00"))));
    const ofHouse = accepted(await service.place(o.sellLimit(treasury, "FLA3", 10, 4410, { ...at("15:00"), actor: "house" })));
    expect(ofHouse.trades).toEqual([]);
    return { ana, bruno, carla, davi, ofAna, ofBruno, ofCarla, ofDavi, ofHouse };
  };

  // ------------------------------------------------------------------ critérios da especificação

  it("livro 40: às 15h40 sai o preço único de R$ 44,50; Ana compra 50 de Bruno, 10 da casa e 40 de Davi, paga R$ 4.450,00 e recebe R$ 50,00 de volta da reserva; as 60 de Davi e a compra de Carla ficam no livro; o preço exibido e a referência passam a R$ 44,50", scene(async () => {
    const b = await book40();
    const fla = club("FLA3");
    expect(await walletOf(db, b.ana)).toEqual({ cash: 1_000_000, reservedCash: 450_000, free: 550_000, openOrders: 1 });

    const r = closed(await closer.closeAuction(seasonId, "FLA3", T1540));

    expect(r).toMatchObject({ seasonId, ticker: "FLA3", clubId: fla, at: T1540, price: 4450, volume: 100, priceBefore: 4000, noTrade: null });
    // os negócios em ordem de preço e chegada, todos ao preço único, com o preço exibido de antes do leilão
    const expected = [
      [b.ofAna.order.id, b.ofBruno.order.id, b.ana, b.bruno, 50, false],
      [b.ofAna.order.id, b.ofHouse.order.id, b.ana, treasury, 10, true],
      [b.ofAna.order.id, b.ofDavi.order.id, b.ana, b.davi, 40, false],
    ];
    const shape = (x: (typeof r.trades)[number]) => [x.buyOrderId, x.sellOrderId, x.buyerWalletId, x.sellerWalletId, x.quantity, x.withHouse];
    expect(r.trades.map(shape)).toEqual(expected);
    const stored = await tradesOf("FLA3");
    expect(stored.map(shape)).toEqual(expected);
    for (const x of stored) expect(x).toMatchObject({ price: 4450, priceBefore: 4000, inAuction: true, at: T1540 });
    expect(r.trades.map((x) => x.id)).toEqual(stored.map((x) => x.id));

    // Ana pagou R$ 4.450,00 e os R$ 50,00 da diferença entre o limite e o preço voltaram para o livre
    expect(await walletOf(db, b.ana)).toEqual({ cash: 555_000, reservedCash: 0, free: 555_000, openOrders: 0 });
    expect(await positionOf(db, b.ana, fla)).toEqual({ shares: 100, reservedShares: 0, free: 100 });
    const anaTrades = (await entriesOf(b.ana)).filter((e) => e.kind === "trade");
    expect(anaTrades.map((e) => [e.cashDelta, e.reservedCashDelta, e.sharesDelta, e.price, e.at])).toEqual([
      [-222_500, -225_000, 50, 4450, T1540],
      [-44_500, -45_000, 10, 4450, T1540],
      [-178_000, -180_000, 40, 4450, T1540],
    ]);
    // os vendedores recebem R$ 44,50 por ação e soltam as ações reservadas
    expect(await walletOf(db, b.bruno)).toMatchObject({ cash: RICH + 222_500, openOrders: 0 });
    expect(await positionOf(db, b.bruno, fla)).toEqual({ shares: 0, reservedShares: 0, free: 0 });
    expect(await walletOf(db, treasury)).toMatchObject({ cash: 44_500, reservedCash: 0, openOrders: 0 });
    expect(await positionOf(db, treasury, fla)).toEqual({ shares: 0, reservedShares: 0, free: 0 });
    expect(await walletOf(db, b.davi)).toMatchObject({ cash: RICH + 178_000, openOrders: 1 });
    expect(await positionOf(db, b.davi, fla)).toEqual({ shares: 60, reservedShares: 60, free: 0 });
    for (const w of [b.bruno, treasury, b.davi]) {
      const sale = (await entriesOf(w)).filter((e) => e.kind === "trade");
      expect(sale.map((e) => [e.cashDelta / -e.sharesDelta, e.reservedSharesDelta === e.sharesDelta])).toEqual(sale.map(() => [4450, true]));
    }

    // as ordens: as de Ana, Bruno e da casa terminaram; a de Davi andou 40; a de Carla ficou como estava
    expect(await orderRow(db, b.ofAna.order.id)).toMatchObject({ status: "filled", filled: 100, reservedCash: 0, updatedAt: T1540 });
    expect(await orderRow(db, b.ofBruno.order.id)).toMatchObject({ status: "filled", filled: 50 });
    expect(await orderRow(db, b.ofHouse.order.id)).toMatchObject({ status: "filled", filled: 10 });
    expect(await orderRow(db, b.ofDavi.order.id)).toMatchObject({ status: "open", filled: 40 });
    expect(await orderRow(db, b.ofCarla.order.id)).toMatchObject({ status: "open", filled: 0, reservedCash: 126_000 });
    expect(await walletOf(db, b.carla)).toMatchObject({ cash: RICH, reservedCash: 126_000, openOrders: 1 });
    expect(await openOrderIds(db, fla)).toEqual([b.ofDavi.order.id, b.ofCarla.order.id]);
    expect(new Map(r.orders.map((x) => [x.id, [x.status, x.filled]]))).toEqual(
      new Map([
        [b.ofAna.order.id, ["filled", 100]],
        [b.ofBruno.order.id, ["filled", 50]],
        [b.ofHouse.order.id, ["filled", 10]],
        [b.ofDavi.order.id, ["open", 40]],
      ]),
    );
    expect(new Set(r.walletIds)).toEqual(new Set([b.ana, b.bruno, treasury, b.davi]));
    expect(r.posts.map((p) => p.entry.kind)).toEqual(Array(6).fill("trade"));

    // o preço exibido e a referência do túnel passam a R$ 44,50, e o leilão acabou
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4450, lastTradeAt: T1540, tunnelRef: 4450, tunnelRefDay: TODAY, auctionOpenedAt: null, auctionUntil: null });
    expect(await displayedPrice(db, seasonId, "FLA3")).toBe(4450);
    expect(r.tunnelRef).toBe(4450);

    // os candles de 15 minutos e do dia, uma vez por negócio: 100 ações a R$ 44,50
    const stick = await db.select().from(candles).where(eq(candles.clubId, fla)).orderBy(asc(candles.interval));
    expect(stick.map((c) => [c.interval, c.start, c.open, c.high, c.low, c.close, c.volume])).toEqual([
      ["15m", brt("2027-04-06", "15:30"), 4450, 4450, 4450, 4450, 100],
      ["1d", TODAY, 4450, 4450, 4450, 4450, 100],
    ]);
    expect(r.candles.map((c) => [c.interval, c.close, c.volume])).toEqual([
      ["15m", 4450, 100],
      ["1d", 4450, 100],
    ]);
  }));

  it("livro 42: o leilão em que Ana cancelou a ordem que o abriu, com compras só até R$ 38,00 e vendas só a partir de R$ 39,00, acaba sem negócio; o preço exibido e a referência continuam em R$ 40,00", scene(async () => {
    const bruno = await holder("FLA3", 50);
    const davi = await holder("FLA3", 100);
    const eva = await holder("FLA3", 10);
    const ana = await player(1_000_000);
    const carla = await player();
    await ready();
    const ofBruno = accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4300, at("12:30"))));
    const ofDavi = accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4450, at("12:30"))));
    const ofAna = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500, at("12:40"))));
    expect(ofAna.openedAuction).toBe(true);
    expect((await cancels.cancelOrder({ walletId: ana, orderId: ofAna.order.id, now: brt("2027-04-06", "13:00") })).ok).toBe(true);
    const ofCarla = accepted(await service.place(o.buyLimit(carla, "FLA3", 30, 3800, at("13:05"))));
    const ofEva = accepted(await service.place(o.sellLimit(eva, "FLA3", 10, 3900, at("13:05"))));
    const before = await rowCounts(db);

    const r = closed(await closer.closeAuction(seasonId, "FLA3", T1540));

    expect(r).toMatchObject({ price: null, volume: 0, trades: [], orders: [], posts: [], walletIds: [], candles: [], priceBefore: 4000, tunnelRef: 4000, noTrade: "no_cross" });
    expect(await rowCounts(db)).toEqual(before);
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4000, lastTradeAt: null, tunnelRef: 4000, tunnelRefDay: TODAY, auctionOpenedAt: null, auctionUntil: null });
    // as ordens ficam no livro como estavam, com a reserva
    expect(await openOrderIds(db, club("FLA3"))).toEqual([ofBruno.order.id, ofDavi.order.id, ofCarla.order.id, ofEva.order.id]);
    expect(await walletOf(db, carla)).toMatchObject({ reservedCash: 30 * 3800, openOrders: 1 });
    expect(await walletOf(db, ana)).toEqual({ cash: 1_000_000, reservedCash: 0, free: 1_000_000, openOrders: 0 });

    // fora de leilão, o clube volta a casar normalmente dentro do túnel de R$ 36,00 a R$ 44,00
    const after = accepted(await service.place(o.buyLimit(carla, "FLA3", 5, 3900, at("15:41"))));
    expect(after.trades.map((x) => [x.price, x.quantity, x.inAuction])).toEqual([[3900, 5, false]]);
  }));

  it("D4: o leilão que passou das 0h e terminou sem negócio mantém a referência antiga até as 0h seguintes", scene(async () => {
    const [seller, buyer, other] = [await holder("PAL3", 10), await player(), await player()];
    await ready();
    // dia 6: referência de R$ 30,00 (o preço às 0h); às 20h um negócio leva o preço a R$ 32,00, dentro do túnel
    await setTunnelState(db, seasonId, club("PAL3"), { lastPrice: 3000, tunnelRef: 3000, tunnelRefDay: TODAY });
    accepted(await service.place(o.sellLimit(seller, "PAL3", 1, 3200, at("20:00"))));
    expect(accepted(await service.place(o.buyLimit(buyer, "PAL3", 1, 3200, at("20:00")))).trades.map((x) => x.price)).toEqual([3200]);
    // às 23h a compra a R$ 34,00 sairia do túnel (até R$ 33,00) e abre o leilão até as 2h do dia 7
    const sale = accepted(await service.place(o.sellLimit(seller, "PAL3", 1, 3400, at("23:00"))));
    const bid = accepted(await service.place(o.buyLimit(buyer, "PAL3", 1, 3400, at("23:00"))));
    expect(bid).toMatchObject({ openedAuction: true, auction: { until: brt("2027-04-07", "02:00") } });
    // à 1h do dia 7 o comprador cancela: o leilão termina sem negócio
    expect((await cancels.cancelOrder({ walletId: buyer, orderId: bid.order.id, now: brt("2027-04-07", "01:00") })).ok).toBe(true);

    const r = closed(await closer.closeAuction(seasonId, "PAL3", brt("2027-04-07", "02:00")));

    expect(r).toMatchObject({ price: null, noTrade: "no_cross", tunnelRef: 3000 });
    // a referência fica a de antes (R$ 30,00, não os R$ 32,00 das 0h do dia 7) e o dia dela passa a ser o 7
    const day7 = brt("2027-04-07", "00:00");
    expect(await row("PAL3")).toMatchObject({ lastPrice: 3200, tunnelRef: 3000, tunnelRefDay: day7, auctionOpenedAt: null, auctionUntil: null });
    // durante o dia 7 ela não vira
    accepted(await service.place(o.buyLimit(other, "PAL3", 1, 3100, at("10:00", "2027-04-07"))));
    expect(await row("PAL3")).toMatchObject({ tunnelRef: 3000, tunnelRefDay: day7 });
    // nas 0h seguintes vira o preço exibido
    accepted(await service.place(o.buyLimit(other, "PAL3", 1, 3150, at("00:30", "2027-04-08"))));
    expect(await row("PAL3")).toMatchObject({ tunnelRef: 3200, tunnelRefDay: brt("2027-04-08", "00:00") });
    expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "open" });
  }));

  it("livro 44: o leilão que atravessa as 0h e fecha com negócio passa a referência ao preço dele, no dia do fechamento", scene(async () => {
    const [seller, buyer] = [await holder("PAL3", 2), await player()];
    await ready();
    await setTunnelState(db, seasonId, club("PAL3"), { lastPrice: 3000, tunnelRef: 3000, tunnelRefDay: TODAY });
    accepted(await service.place(o.sellLimit(seller, "PAL3", 1, 3400, at("23:00"))));
    expect(accepted(await service.place(o.buyLimit(buyer, "PAL3", 1, 3400, at("23:00")))).openedAuction).toBe(true);
    // às 0h30 do dia 7, em leilão, a referência continua R$ 30,00 (critério 44)
    accepted(await service.place(o.sellLimit(seller, "PAL3", 1, 3500, at("00:30", "2027-04-07"))));
    expect(await row("PAL3")).toMatchObject({ tunnelRef: 3000, tunnelRefDay: TODAY });

    const r = closed(await closer.closeAuction(seasonId, "PAL3", brt("2027-04-07", "02:00")));

    expect(r).toMatchObject({ price: 3400, volume: 1, tunnelRef: 3400, priceBefore: 3000 });
    expect(await row("PAL3")).toMatchObject({ lastPrice: 3400, tunnelRef: 3400, tunnelRefDay: brt("2027-04-07", "00:00") });
  }));

  // ------------------------------------------------------------------ quem chega depois do fim (P10)

  it("a ordem que chega às 15h40min02s, antes da tarefa, fecha o leilão primeiro, com o horário real do fechamento, e casa com a referência nova (P10)", scene(async () => {
    const eva = await player();
    const b = await book40();
    const arrival = later(T1540, 2_000);

    // com a referência antiga (túnel até R$ 44,00), a compra a R$ 48,00 que pega a venda de Davi a R$ 44,50 abriria
    // um leilão; com a nova, de R$ 44,50 (túnel de R$ 40,05 a R$ 48,95), casa na hora
    const r = accepted(await service.place(o.buyLimit(eva, "FLA3", 60, 4800, { now: arrival })));

    const all = await tradesOf("FLA3");
    expect(all.filter((x) => x.inAuction).map((x) => [x.sellerWalletId, x.quantity, x.price, x.at])).toEqual([
      [b.bruno, 50, 4450, arrival],
      [treasury, 10, 4450, arrival],
      [b.davi, 40, 4450, arrival],
    ]);
    expect(r.trades.map((x) => [x.sellerWalletId, x.quantity, x.price, x.inAuction, x.priceBefore, x.at])).toEqual([[b.davi, 60, 4450, false, 4450, arrival]]);
    expect(r).toMatchObject({ openedAuction: false, auction: null });
    expect(r.order).toMatchObject({ status: "filled", filled: 60 });
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4450, tunnelRef: 4450, auctionOpenedAt: null, auctionUntil: null });
    expect(await orderRow(db, b.ofDavi.order.id)).toMatchObject({ status: "filled", filled: 100 });
  }));

  it("o cancelamento que chega depois do fim fecha o leilão antes: Davi cancela às 15h40min01s e só as 60 que sobraram voltam; a ordem de Ana já executou (P10)", scene(async () => {
    const b = await book40();
    const arrival = later(T1540, 1_000);

    const r = await cancels.cancelOrder({ walletId: b.davi, orderId: b.ofDavi.order.id, now: arrival });

    if (!r.ok) throw new Error(r.code);
    expect(r.order).toMatchObject({ status: "cancelled", cancelReason: "player", filled: 40 });
    expect(await positionOf(db, b.davi, club("FLA3"))).toEqual({ shares: 60, reservedShares: 0, free: 60 });
    expect((await tradesOf("FLA3")).map((x) => [x.quantity, x.price, x.at])).toEqual([
      [50, 4450, arrival],
      [10, 4450, arrival],
      [40, 4450, arrival],
    ]);
    expect(await cancels.cancelOrder({ walletId: b.ana, orderId: b.ofAna.order.id, now: arrival })).toEqual({ ok: false, code: "order_not_open" });
  }));

  // ------------------------------------------------------------------ quando não fecha

  it("chamar closeAuction duas vezes não faz nada na segunda; o leilão ainda no futuro, o clube fora de leilão e o leilão parado pela suspensão também não", scene(async () => {
    await book40();
    const untouched = await snapshot("FLA3");

    // às 15h39min59s o leilão ainda corre
    expect(await closer.closeAuction(seasonId, "FLA3", later(T1540, -1_000))).toEqual({ closed: false, reason: "not_expired", seasonId, ticker: "FLA3" });
    expect(await snapshot("FLA3")).toEqual(untouched);

    expect(closed(await closer.closeAuction(seasonId, "FLA3", T1540)).trades).toHaveLength(3);
    const done = await snapshot("FLA3");
    // a tarefa seguinte (ou uma ordem atrasada) encontra o leilão já fechado
    expect(await closer.closeAuction(seasonId, "FLA3", later(T1540, 5_000))).toEqual({ closed: false, reason: "not_in_auction", seasonId, ticker: "FLA3" });
    expect(await snapshot("FLA3")).toEqual(done);

    // o PAL3 nunca esteve em leilão; o SPT3 está parado pela suspensão (início sem fim): nenhum dos dois fecha
    expect(await closer.closeAuction(seasonId, "PAL3", T1540)).toMatchObject({ closed: false, reason: "not_in_auction" });
    await setTunnelState(db, seasonId, club("SPT3"), { auctionOpenedAt: T1240, auctionUntil: null, tunnelRef: 4000, tunnelRefDay: TODAY });
    const paused = await snapshot("SPT3");
    expect(await closer.closeAuction(seasonId, "SPT3", brt("2027-04-09", "12:00"))).toMatchObject({ closed: false, reason: "paused" });
    expect(await snapshot("SPT3")).toEqual(paused);
    await setTunnelState(db, seasonId, club("SPT3"), { auctionOpenedAt: null, auctionUntil: null });
  }));

  it("com o clube ou o mercado suspenso, o leilão vencido não fecha (nada executa na suspensão); na retomada, fecha", scene(async () => {
    await book40();
    const untouched = await snapshot("FLA3");

    await db.update(seasonClubs).set({ suspendedReason: "Placar em revisão" }).where(clubWhere("FLA3"));
    expect(await closer.closeAuction(seasonId, "FLA3", T1540)).toEqual({ closed: false, reason: "club_suspended", seasonId, ticker: "FLA3" });
    await db.update(seasonClubs).set({ suspendedReason: null }).where(clubWhere("FLA3"));
    await db.update(seasons).set({ suspendedReason: "Mercado em revisão" }).where(eq(seasons.id, seasonId));
    expect(await closer.closeAuction(seasonId, "FLA3", T1540)).toMatchObject({ closed: false, reason: "club_suspended" });
    expect(await snapshot("FLA3")).toEqual(untouched);

    await db.update(seasons).set({ suspendedReason: null }).where(eq(seasons.id, seasonId));
    const at16 = brt("2027-04-06", "16:00");
    expect(closed(await closer.closeAuction(seasonId, "FLA3", at16))).toMatchObject({ price: 4450, volume: 100, at: at16 });
  }));

  it("com a negociação encerrada, o leilão vencido não fecha: quem encerra o leilão sem negócio é o fim da negociação, junto com o cancelamento das ordens", scene(async () => {
    await book40();
    const untouched = await snapshot("FLA3");
    await db.update(seasons).set({ status: "trading_ended", tradingEndedAt: brt("2027-04-06", "15:00") }).where(eq(seasons.id, seasonId));

    expect(await closer.closeAuction(seasonId, "FLA3", T1540)).toEqual({ closed: false, reason: "market_closed", seasonId, ticker: "FLA3" });
    expect(await snapshot("FLA3")).toEqual(untouched);
    await db.update(seasons).set({ status: "trading", tradingEndedAt: null }).where(eq(seasons.id, seasonId));
  }));

  it("o horário dos negócios do leilão nunca recua: se o último negócio do clube é posterior ao relógio de quem fecha, os negócios saem com ele", scene(async () => {
    const b = await book40();
    // um relógio atrasado (outra instância da API): o fim do leilão já venceu pelo último negócio do clube
    const lastTrade = later(T1540, 10_000);
    await db.update(seasonClubs).set({ lastTradeAt: lastTrade }).where(clubWhere("FLA3"));

    const r = closed(await closer.closeAuction(seasonId, "FLA3", later(T1540, -60_000)));

    expect(r.at).toEqual(lastTrade);
    expect((await tradesOf("FLA3")).map((x) => x.at)).toEqual([lastTrade, lastTrade, lastTrade]);
    expect(await row("FLA3")).toMatchObject({ lastTradeAt: lastTrade });
    expect(await walletOf(db, b.ana)).toMatchObject({ reservedCash: 0 });
  }));

  it("o livro é lido em páginas: com páginas de 2 ordens o resultado é o mesmo do critério 40", scene(async () => {
    const b = await book40();
    closer.pageSize = 2;
    const r = closed(await closer.closeAuction(seasonId, "FLA3", T1540));
    expect(r.trades.map((x) => [x.sellerWalletId, x.quantity, x.price])).toEqual([
      [b.bruno, 50, 4450],
      [treasury, 10, 4450],
      [b.davi, 40, 4450],
    ]);
  }));

  // ------------------------------------------------------------------ propriedade

  it("propriedade: com ordens sorteadas (semente fixa, 100 cenários) o preço é o do motor, a sobra nunca fica cruzada e o dinheiro, as ações, as reservas e as ordens abertas se conservam", () =>
    rolledBack(t.db, async (outer) => {
      db = outer;
      const ledger = new PortfolioLedger();
      const engine = new PostgresMatchingEngine(ledger);
      const fla = club("FLA3");
      const house = await openTreasury(db, seasonId, 5_000_000);
      const people: number[] = [];
      for (let i = 0; i < 6; i++) people.push(await holder("FLA3", 200, 2_000_000));
      await giveShares(db, house, fla, 200);
      await ready();
      const base = cashBefore!;
      o = orderInputs({ seasonId, now: T1240 });
      const random = rng(20271106);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
      const stats = { traded: 0, noTrade: 0, orders: 0, rejected: 0 };

      for (let scenario = 0; scenario < 100; scenario++) {
        await rolledBack(outer, async (inner) => {
          db = inner;
          const auctionCloser = new CloseAuctionService(db, ledger);
          const placer = new OrderService(db, engine, new CloseAuctionAdapter(auctionCloser));
          const reference = 3800 + 50 * Math.floor(random() * 9);
          await setTunnelState(db, seasonId, fla, { lastPrice: 4000, tunnelRef: reference, tunnelRefDay: TODAY, auctionOpenedAt: T1240, auctionUntil: T1540 });
          const count = 2 + Math.floor(random() * 13);
          for (let i = 0; i < count; i++) {
            const wallet = pick([...people, house]);
            const side = random() < 0.5 ? "buy" : "sell";
            const price = 3600 + 50 * Math.floor(random() * 17);
            const quantity = 1 + Math.floor(random() * 30);
            const input = (side === "buy" ? o.buyLimit : o.sellLimit)(wallet, "FLA3", quantity, price, {
              now: later(T1240, 60_000 * (i + 1)),
              ...(wallet === house ? { actor: "house" as const } : {}),
            });
            const placed = await placer.place(input);
            if (placed.ok) {
              stats.orders++;
              expect(placed.trades).toEqual([]);
            } else stats.rejected++;
          }
          // o livro antes do fim, para conferir com a conta pura do motor
          const book = await db.select().from(orders).where(and(eq(orders.clubId, fla), eq(orders.status, "open")));
          const auctionOrders: AuctionOrder[] = book.map((x) => ({
            id: x.id,
            accountId: String(x.walletId),
            side: x.side as "buy" | "sell",
            limitPrice: x.limitPrice!,
            remaining: x.quantity - x.filled,
          }));
          const expected = clearAuction(auctionOrders, reference);
          const limits = new Map(book.map((x) => [x.id, x.limitPrice!]));

          const r = closed(await auctionCloser.closeAuction(seasonId, "FLA3", T1540));

          expect(r.price).toBe(expected.price);
          expect(r.volume).toBe(expected.volume);
          expect(r.trades.map((x) => [x.buyOrderId, x.sellOrderId, x.quantity])).toEqual(expected.fills.map((f) => [f.buyOrderId, f.sellOrderId, f.quantity]));
          expect(r.trades.reduce((n, x) => n + x.quantity, 0)).toBe(r.volume);
          for (const x of r.trades) {
            expect(x).toMatchObject({ price: r.price, inAuction: true, priceBefore: 4000, at: T1540 });
            expect(x.buyerWalletId).not.toBe(x.sellerWalletId);
            expect(limits.get(x.buyOrderId)!).toBeGreaterThanOrEqual(x.price);
            expect(limits.get(x.sellOrderId)!).toBeLessThanOrEqual(x.price);
            expect(x.withHouse).toBe(x.buyerWalletId === house || x.sellerWalletId === house);
          }
          const after = await row("FLA3");
          expect(after).toMatchObject({ auctionOpenedAt: null, auctionUntil: null, tunnelRef: r.price ?? reference, lastPrice: r.price ?? 4000 });
          if (r.price === null) stats.noTrade++;
          else stats.traded++;

          // a sobra nunca fica cruzada, e o dinheiro, as ações, as reservas e as ordens abertas batem
          await assertBookNotCrossed(db, seasonId);
          await assertLedgerConsistent(db, seasonId);
          await assertSharesConserved(db, seasonId);
          expect(await totalCash(db, seasonId)).toBe(base);
          await assertOpenOrdersCounter(db, seasonId);
          await assertReservesMatchOrders(db, seasonId);
        });
      }
      // os sorteios cobriram os dois desfechos
      expect(stats.traded).toBeGreaterThan(20);
      expect(stats.noTrade).toBeGreaterThan(0);
      expect(stats.orders).toBeGreaterThan(300);
    }), 120_000);
});
