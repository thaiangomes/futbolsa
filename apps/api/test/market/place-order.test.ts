import "reflect-metadata";
import { asc, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/infra/db/client.js";
import { type Tx, withTransaction } from "../../src/infra/db/index.js";
import { orders, seasonClubs, seasons, trades, walletEntries } from "../../src/infra/db/schema/index.js";
import {
  displayedPrice,
  inMatch,
  MatchingEngine,
  OrderService,
  type PlaceOrderInput,
  type PlaceOrderResult,
  type PostgresMatchingEngine,
} from "../../src/modules/market/index.js";
import { useTestDatabase } from "../support/db.js";
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
  orderService,
  positionOf,
  rejected,
  rolledBack,
  reverseCash,
  rowCounts,
  setDisplayedPrice,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// T4 do Plano do livro de ofertas e formador: a ordem nova pelo serviço, no banco, com os números da especificação
// (Livro de ofertas e formador de mercado, critérios 1 a 8, 10, 11, 13 a 15, 17 e 30).

/** Terça, 6 de abril de 2027, 10h05 de Brasília: a negociação abriu na véspera às 10h. */
const NOW = new Date("2027-04-06T13:05:00Z");
const TICKERS = ["FLA3", "PAL3", "SPT3", "COR3", "CAM3"];
/** R$ 100.000,00: caixa de quem só está no teste para ser contraparte. */
const RICH = 10_000_000;

describe("ordem nova no Postgres", () => {
  const t = useTestDatabase(5);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let service: OrderService;
  let engine: PostgresMatchingEngine;
  let o: ReturnType<typeof orderInputs>;
  /** O caixa total depois da montagem do teste; `undefined` até o teste chamar `ready`. */
  let cashBefore: number | undefined;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  /**
   * Cada teste começa do zero (livro vazio, clubes a R$ 40,00 e só a tesouraria, sem caixa nem ações) e termina
   * conferindo o critério 30 e as invariantes do livro. Para não criar um banco por teste (uns 2 segundos cada), o
   * teste roda dentro de uma transação que é desfeita no fim: cada `withTransaction` do serviço vira um ponto de
   * salvamento dela. As transações de verdade, uma por conexão, ficam com `place-order-concurrency.test.ts`.
   */
  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      // a tesouraria nasce antes das carteiras dos jogadores: o id dela é o menor, e ela é travada por último
      treasury = await openTreasury(db, seasonId);
      ({ service, engine } = orderService(db));
      o = orderInputs({ seasonId, now: NOW });
      cashBefore = undefined;
      await body();
      if (cashBefore === undefined) throw new Error("o teste não chamou ready() depois de montar as carteiras");
      await assertMarketInvariants(db, seasonId, cashBefore);
    });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const player = (cash = RICH) => openPlayer(db, seasonId, cash);
  /** Um jogador que já tem ações do clube. */
  const holder = async (ticker: string, shares: number, cash = RICH) => {
    const wallet = await player(cash);
    await giveShares(db, wallet, club(ticker), shares);
    return wallet;
  };
  /** Fim da montagem: fixa as ações de cada clube e o caixa total que o teste tem de conservar. */
  const ready = async () => {
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  };
  const price = async (ticker: string) => (await clubRow(db, seasonId, club(ticker))).lastPrice;
  const entriesOf = (walletId: number) => db.select().from(walletEntries).where(eq(walletEntries.walletId, walletId)).orderBy(asc(walletEntries.id));
  const tradesOf = (ticker: string) => db.select().from(trades).where(eq(trades.clubId, club(ticker))).orderBy(asc(trades.id));

  // ------------------------------------------------------------------ critérios da especificação

  it("livro 1: compra limitada de 100 a R$ 40,00 sem venda até esse preço fica no livro com R$ 4.000,00 reservados", scene(async () => {
    const ana = await player(1_000_000);
    const bruno = await holder("FLA3", 10);
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4001))); // a venda mais barata está 1 centavo acima

    const r = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4000)));

    expect(r.trades).toEqual([]);
    expect(r.order).toMatchObject({ ticker: "FLA3", side: "buy", type: "limit", quantity: 100, filled: 0, limitPrice: 4000, reservedCash: 400_000, status: "open", cancelReason: null });
    expect(r.cash).toEqual({ total: 1_000_000, reserved: 400_000, free: 600_000 });
    expect(await walletOf(db, ana)).toEqual({ cash: 1_000_000, reservedCash: 400_000, free: 600_000, openOrders: 1 });
    expect(await orderRow(db, r.order.id)).toMatchObject({ status: "open", filled: 0, reservedCash: 400_000, createdAt: NOW, walletId: ana });
    const [reserve] = (await entriesOf(ana)).slice(-1);
    expect(reserve).toMatchObject({ kind: "order_reserve", reservedCashDelta: 400_000, cashDelta: 0, refType: "order", refId: String(r.order.id), clubId: club("FLA3") });
    expect(await price("FLA3")).toBe(4000);
  }));

  it("livro 2: compra de 150 a R$ 41,00 leva 100 de Davi a R$ 40,50 e 50 de Bruno a R$ 41,00; a venda de Carla, que chegou depois, fica inteira", scene(async () => {
    const [bruno, carla, davi] = [await holder("FLA3", 100), await holder("FLA3", 100), await holder("FLA3", 100)];
    const ana = await player(1_000_000);
    await ready();
    const at = (hhmm: string) => ({ now: new Date(`2027-04-06T${hhmm}:00Z`) });
    const ofBruno = accepted(await service.place(o.sellLimit(bruno, "FLA3", 100, 4100, at("13:00"))));
    const ofCarla = accepted(await service.place(o.sellLimit(carla, "FLA3", 100, 4100, at("13:05"))));
    const ofDavi = accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4050, at("13:10"))));

    const r = accepted(await service.place(o.buyLimit(ana, "FLA3", 150, 4100, at("13:15"))));

    expect(r.trades.map((t) => [t.sellerWalletId, t.quantity, t.price])).toEqual([
      [davi, 100, 4050],
      [bruno, 50, 4100],
    ]);
    expect(r.order).toMatchObject({ status: "filled", filled: 150, reservedCash: 0 });
    // paga o preço de quem estava no livro: R$ 4.050,00 + R$ 2.050,00
    expect(await walletOf(db, ana)).toEqual({ cash: 1_000_000 - 610_000, reservedCash: 0, free: 390_000, openOrders: 0 });
    expect(await positionOf(db, ana, club("FLA3"))).toMatchObject({ shares: 150, reservedShares: 0 });
    expect(await orderRow(db, ofDavi.order.id)).toMatchObject({ status: "filled", filled: 100 });
    expect(await orderRow(db, ofBruno.order.id)).toMatchObject({ status: "open", filled: 50 });
    expect(await orderRow(db, ofCarla.order.id)).toMatchObject({ status: "open", filled: 0 });
    expect(await walletOf(db, davi)).toMatchObject({ cash: RICH + 405_000, openOrders: 0 });
    expect(await walletOf(db, bruno)).toMatchObject({ cash: RICH + 205_000, openOrders: 1 });
    expect(await positionOf(db, bruno, club("FLA3"))).toEqual({ shares: 50, reservedShares: 50, free: 0 });
    expect(await positionOf(db, carla, club("FLA3"))).toEqual({ shares: 100, reservedShares: 100, free: 0 });
    expect(await price("FLA3")).toBe(4100);
    // o que a T7 publica: as ordens do livro que mexeram e as carteiras com extrato novo
    expect(r.bookOrders.map((b) => [b.id, b.status, b.filled])).toEqual([
      [ofDavi.order.id, "filled", 100],
      [ofBruno.order.id, "open", 50],
    ]);
    expect([...r.walletIds].sort()).toEqual([ana, bruno, davi].sort());
  }));

  it("livro 3: compra de 100 a R$ 44,50 leva 10 da casa e 50 de Bruno, paga R$ 2.656,00, deixa 40 no livro com R$ 1.780,00 e devolve R$ 14,00", scene(async () => {
    await giveShares(db, treasury, club("FLA3"), 10);
    const bruno = await holder("FLA3", 50);
    const ana = await player(1_000_000);
    const carla = await player();
    await setDisplayedPrice(db, seasonId, club("FLA3"), 4300);
    await ready();
    const house = accepted(await service.place(o.sellLimit(treasury, "FLA3", 10, 4410, { actor: "house" })));
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4430)));

    const r = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4450)));

    expect(r.trades.map((t) => ({ quantity: t.quantity, price: t.price, seller: t.sellerWalletId, withHouse: t.withHouse, priceBefore: t.priceBefore }))).toEqual([
      { quantity: 10, price: 4410, seller: treasury, withHouse: true, priceBefore: 4300 },
      { quantity: 50, price: 4430, seller: bruno, withHouse: false, priceBefore: 4410 },
    ]);
    expect(r.order).toMatchObject({ status: "open", filled: 60, reservedCash: 178_000 });
    // R$ 4.450,00 reservados na entrada; R$ 2.656,00 pagos; R$ 1.780,00 seguem reservados; R$ 14,00 voltam ao livre
    expect(r.cash).toEqual({ total: 1_000_000 - 265_600, reserved: 178_000, free: 1_000_000 - 445_000 + 1_400 });
    expect(await walletOf(db, ana)).toEqual({ cash: 734_400, reservedCash: 178_000, free: 556_400, openOrders: 1 });
    expect(await positionOf(db, ana, club("FLA3"))).toMatchObject({ shares: 60 });
    expect(r.club).toEqual({ clubId: club("FLA3"), ticker: "FLA3", price: 4430, priceBefore: 4300 });
    expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ lastPrice: 4430, lastTradeAt: NOW });
    // a casa vendeu as 10: o lado da venda dela fica vazio até a reposição
    expect(await orderRow(db, house.order.id)).toMatchObject({ status: "filled", filled: 10 });
    expect(await walletOf(db, treasury)).toMatchObject({ cash: 44_100, openOrders: 0 });
    expect(await positionOf(db, treasury, club("FLA3"))).toMatchObject({ shares: 0, reservedShares: 0 });
    // o extrato de Ana: a reserva da entrada e uma linha por negócio; cada linha do negócio aponta para ele
    expect((await entriesOf(ana)).slice(1).map((e) => [e.kind, e.cashDelta, e.reservedCashDelta, e.sharesDelta])).toEqual([
      ["order_reserve", 0, 445_000, 0],
      ["trade", -44_100, -44_500, 10],
      ["trade", -221_500, -222_500, 50],
    ]);
    expect(r.posts.map((p) => [p.entry.walletId, p.entry.kind])).toEqual([
      [ana, "order_reserve"],
      [ana, "trade"],
      [treasury, "trade"],
      [ana, "trade"],
      [bruno, "trade"],
    ]);
    expect(r.posts[4]!.entry).toMatchObject({ refType: "trade", refId: String(r.trades[1]!.id), price: 4430, realized: 50 * 430 });
    // o limite anda com o negócio: de R$ 35,44 a R$ 53,16
    expect(rejected(await service.place(o.buyLimit(carla, "FLA3", 1, 5317))).code).toBe("price_out_of_band");
    expect(rejected(await service.place(o.sellLimit(carla, "FLA3", 1, 3543))).code).toBe("price_out_of_band");
    accepted(await service.place(o.buyLimit(carla, "FLA3", 1, 3544)));
  }));

  it("livro 4: compra a mercado de 50 com R$ 1.000,00 livres compra 33 a R$ 30,00 e as outras 17 são canceladas", scene(async () => {
    const bruno = await holder("PAL3", 100);
    const ana = await player(100_000);
    await setDisplayedPrice(db, seasonId, club("PAL3"), 3000);
    await ready();
    const sale = accepted(await service.place(o.sellLimit(bruno, "PAL3", 100, 3000)));

    const r = accepted(await service.place(o.buyMarket(ana, "PAL3", 50)));

    expect(r.trades.map((t) => [t.quantity, t.price])).toEqual([[33, 3000]]);
    expect(r.order).toMatchObject({ type: "market", limitPrice: null, quantity: 50, filled: 33, status: "cancelled", cancelReason: "market_remainder", reservedCash: 0 });
    expect(r.cash).toEqual({ total: 1_000, reserved: 0, free: 1_000 });
    expect(await walletOf(db, ana)).toEqual({ cash: 1_000, reservedCash: 0, free: 1_000, openOrders: 0 });
    expect(await positionOf(db, ana, club("PAL3"))).toMatchObject({ shares: 33 });
    expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "open", filled: 33 });
    // a compra a mercado não reserva: o extrato só tem o negócio
    expect((await entriesOf(ana)).slice(1).map((e) => e.kind)).toEqual(["trade"]);
  }));

  it("livro 5: venda a mercado de 200 com 120 de compra no livro vende 120 e as 80 voltam a ficar livres; a de 800 é recusada", scene(async () => {
    const ana = await holder("FLA3", 700);
    const [bruno, carla] = [await player(), await player()];
    await ready();
    accepted(await service.place(o.buyLimit(bruno, "FLA3", 70, 4000)));
    accepted(await service.place(o.buyLimit(carla, "FLA3", 50, 3900)));

    const r = accepted(await service.place(o.sellMarket(ana, "FLA3", 200)));

    expect(r.trades.map((t) => [t.buyerWalletId, t.quantity, t.price])).toEqual([
      [bruno, 70, 4000],
      [carla, 50, 3900],
    ]);
    expect(r.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", filled: 120, quantity: 200 });
    expect(await positionOf(db, ana, club("FLA3"))).toEqual({ shares: 580, reservedShares: 0, free: 580 });
    expect(await walletOf(db, ana)).toMatchObject({ cash: RICH + 280_000 + 195_000, openOrders: 0 });
    expect((await entriesOf(ana)).slice(2).map((e) => [e.kind, e.sharesDelta, e.reservedSharesDelta])).toEqual([
      ["order_reserve", 0, 200],
      ["trade", -70, -70],
      ["trade", -50, -50],
      ["order_release", 0, -80],
    ]);
    expect(await walletOf(db, bruno)).toMatchObject({ reservedCash: 0, openOrders: 0 });

    const before = await rowCounts(db);
    expect(rejected(await service.place(o.sellMarket(ana, "FLA3", 800)))).toEqual({ ok: false, code: "insufficient_shares" });
    expect(await rowCounts(db)).toEqual(before);
  }));

  it("livro 6: com o preço em R$ 40,00, compra a R$ 48,01 e venda a R$ 31,99 são recusadas; a R$ 48,00 e a R$ 32,00 são aceitas (jogador e bot)", scene(async () => {
    const ana = await holder("FLA3", 10);
    const bot = await openBot(db, seasonId, RICH);
    await giveShares(db, bot, club("PAL3"), 10);
    await ready();

    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4801)))).toEqual({ ok: false, code: "price_out_of_band" });
    expect(rejected(await service.place(o.sellLimit(ana, "FLA3", 1, 3199))).code).toBe("price_out_of_band");
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 1, 4800))).order.status).toBe("open");
    // o bot manda pela mesma entrada e esbarra na mesma faixa
    expect(rejected(await service.place(o.buyLimit(bot, "PAL3", 1, 4801, { actor: "bot" }))).code).toBe("price_out_of_band");
    expect(rejected(await service.place(o.sellLimit(bot, "PAL3", 1, 3199, { actor: "bot" }))).code).toBe("price_out_of_band");
    expect(accepted(await service.place(o.sellLimit(bot, "PAL3", 1, 3200, { actor: "bot" }))).order.status).toBe("open");
  }));

  it("livro 7: compra a mercado de 120 com vendas de 50 a R$ 47,00 e 100 a R$ 49,00 compra só as 50: R$ 49,00 passa de R$ 48,00", scene(async () => {
    const [bruno, carla] = [await holder("FLA3", 50), await holder("FLA3", 100)];
    const ana = await player();
    await ready();
    // as duas vendas entraram com o preço em R$ 45,00; depois ele caiu a R$ 40,00 e elas ficaram no livro
    await setDisplayedPrice(db, seasonId, club("FLA3"), 4500);
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4700)));
    const far = accepted(await service.place(o.sellLimit(carla, "FLA3", 100, 4900)));
    await setDisplayedPrice(db, seasonId, club("FLA3"), 4000);

    const r = accepted(await service.place(o.buyMarket(ana, "FLA3", 120)));

    expect(r.trades.map((t) => [t.quantity, t.price])).toEqual([[50, 4700]]);
    expect(r.order).toMatchObject({ filled: 50, status: "cancelled", cancelReason: "market_remainder" });
    expect(await orderRow(db, far.order.id)).toMatchObject({ status: "open", filled: 0 });
    expect(await walletOf(db, ana)).toMatchObject({ cash: RICH - 235_000, reservedCash: 0 });
  }));

  it("livro 8: depois de um negócio a R$ 48,00 a compra limitada a R$ 57,00 é aceita: o limite passou a ir de R$ 38,40 a R$ 57,60", scene(async () => {
    const bruno = await holder("FLA3", 20);
    const [carla, ana] = [await player(), await player()];
    await ready();
    // Com o túnel de 10% em volta do preço das 0h, o negócio a R$ 48,00 não sai direto de R$ 40,00: o preço sobe a
    // R$ 44,00 num dia e a R$ 48,00 no seguinte (ou de uma vez, num leilão). O limite de 20% anda com cada negócio.
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4400)));
    expect(accepted(await service.place(o.buyLimit(carla, "FLA3", 10, 4400))).trades).toHaveLength(1);
    const nextDay = { now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) };
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4800, nextDay)));
    expect(accepted(await service.place(o.buyLimit(carla, "FLA3", 10, 4800, nextDay))).trades.map((x) => x.price)).toEqual([4800]);
    expect(await price("FLA3")).toBe(4800);

    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 5761, nextDay))).code).toBe("price_out_of_band");
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 3839, nextDay))).code).toBe("price_out_of_band");
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 1, 5700, nextDay))).order).toMatchObject({ status: "open", reservedCash: 5700 });
  }));

  it("livro 10: com o preço em R$ 0,55, a venda a R$ 0,49 é recusada pelo piso e a de R$ 0,50 é aceita", scene(async () => {
    const ana = await holder("SPT3", 10);
    await setDisplayedPrice(db, seasonId, club("SPT3"), 55);
    await ready();

    expect(rejected(await service.place(o.sellLimit(ana, "SPT3", 1, 49)))).toEqual({ ok: false, code: "below_min_price" });
    expect(accepted(await service.place(o.sellLimit(ana, "SPT3", 1, 50))).order).toMatchObject({ status: "open", limitPrice: 50 });
  }));

  it("livro 11: a venda de Ana a R$ 47,00 continua no livro quando o preço cai a R$ 35,00, e a compra de Bruno a R$ 47,00 é recusada", scene(async () => {
    const [ana, davi] = [await holder("FLA3", 10), await holder("FLA3", 10)];
    const [bruno, carla] = [await player(), await player()];
    await ready();
    const sale = accepted(await service.place(o.sellLimit(ana, "FLA3", 10, 4700)));
    // O preço cai a R$ 35,00 com negócios entre Carla e Davi: a R$ 36,00 hoje (a beira do túnel de R$ 40,00) e a
    // R$ 35,00 amanhã, com a referência nova.
    accepted(await service.place(o.buyLimit(carla, "FLA3", 5, 3600)));
    expect(accepted(await service.place(o.sellLimit(davi, "FLA3", 5, 3600))).trades.map((t) => t.price)).toEqual([3600]);
    const nextDay = { now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000) };
    accepted(await service.place(o.buyLimit(carla, "FLA3", 5, 3500, nextDay)));
    expect(accepted(await service.place(o.sellLimit(davi, "FLA3", 5, 3500, nextDay))).trades.map((t) => t.price)).toEqual([3500]);
    expect(await price("FLA3")).toBe(3500);

    expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "open", filled: 0, limitPrice: 4700 });
    // o limite foi a R$ 42,00: Bruno não alcança mais a venda de Ana
    expect(rejected(await service.place(o.buyLimit(bruno, "FLA3", 10, 4700, nextDay))).code).toBe("price_out_of_band");
    expect(accepted(await service.place(o.buyLimit(bruno, "FLA3", 10, 4200, nextDay))).trades).toEqual([]);
  }));

  it("livro 13: com uma venda aberta a R$ 42,00, a compra limitada a R$ 42,00 e a compra a mercado são recusadas; a R$ 41,99 é aceita", scene(async () => {
    const ana = await holder("FLA3", 10);
    await ready();
    accepted(await service.place(o.sellLimit(ana, "FLA3", 10, 4200)));
    const before = await rowCounts(db);

    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 5, 4200)))).toEqual({ ok: false, code: "self_trade" });
    expect(rejected(await service.place(o.buyMarket(ana, "FLA3", 5)))).toEqual({ ok: false, code: "self_trade" });
    expect(await rowCounts(db)).toEqual(before);
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 5, 4199))).order.status).toBe("open");
    // em outro clube a venda de FLA3 não atrapalha
    expect(accepted(await service.place(o.buyMarket(ana, "PAL3", 5))).order.status).toBe("cancelled");
  }));

  it("livro 14: ordem de 0 ação, de 1,5 ação ou com preço de R$ 40,005 é recusada", scene(async () => {
    const ana = await player();
    await ready();
    const before = await rowCounts(db);

    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 0, 4000)))).toEqual({ ok: false, code: "invalid_quantity" });
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1.5, 4000))).code).toBe("invalid_quantity");
    expect(rejected(await service.place(o.buyMarket(ana, "FLA3", 1.5))).code).toBe("invalid_quantity");
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4000.5))).code).toBe("invalid_price");
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, undefined))).code).toBe("invalid_price");
    // mais ações do que a coluna da ordem guarda: a compra a mercado não reserva nada e passaria pelo motor
    expect(rejected(await service.place(o.buyMarket(ana, "FLA3", 3_000_000_000))).code).toBe("invalid_quantity");
    expect(await rowCounts(db)).toEqual(before);
  }));

  it("livro 15: com 50 ordens abertas somando os clubes, a 51ª é recusada; quando uma delas executa, a seguinte é aceita", scene(async () => {
    const ana = await player();
    const bruno = await holder("FLA3", 1);
    await ready();
    for (let i = 0; i < 50; i++) {
      const ticker = TICKERS[i % TICKERS.length]!;
      accepted(await service.place(o.buyLimit(ana, ticker, 1, 3600 + i)));
    }
    expect(await walletOf(db, ana)).toMatchObject({ openOrders: 50 });

    expect(rejected(await service.place(o.buyLimit(ana, "PAL3", 1, 4000)))).toEqual({ ok: false, code: "too_many_open_orders" });
    // a ordem a mercado nunca fica aberta: não conta para o limite
    expect(accepted(await service.place(o.buyMarket(ana, "PAL3", 1))).order.status).toBe("cancelled");
    // Bruno vende 1 FLA3 a mercado e executa a melhor compra de Ana: sobram 49 abertas (o cancelamento é da T6)
    expect(accepted(await service.place(o.sellMarket(bruno, "FLA3", 1))).trades).toHaveLength(1);
    expect(await walletOf(db, ana)).toMatchObject({ openOrders: 49 });
    expect(accepted(await service.place(o.buyLimit(ana, "PAL3", 1, 4000))).order.status).toBe("open");
    expect(rejected(await service.place(o.buyLimit(ana, "SPT3", 1, 4000))).code).toBe("too_many_open_orders");
  }));

  it("livro 17: com o caixa em −R$ 250,00 a compra a mercado é recusada; a venda de 100 CAM3 a R$ 20,00 executa e o caixa vai a R$ 1.750,00", scene(async () => {
    const bruno = await holder("CAM3", 100, 0);
    await reverseCash(db, bruno, club("CAM3"), 25_000);
    const carla = await player();
    await setDisplayedPrice(db, seasonId, club("CAM3"), 2000);
    await ready();
    accepted(await service.place(o.buyLimit(carla, "CAM3", 100, 2000)));
    expect(await walletOf(db, bruno)).toMatchObject({ cash: -25_000 });

    expect(rejected(await service.place(o.buyMarket(bruno, "CAM3", 1)))).toEqual({ ok: false, code: "negative_cash" });
    expect(rejected(await service.place(o.buyLimit(bruno, "CAM3", 1, 2000))).code).toBe("negative_cash");

    const r = accepted(await service.place(o.sellMarket(bruno, "CAM3", 100)));
    expect(r.trades.map((t) => [t.quantity, t.price])).toEqual([[100, 2000]]);
    expect(r.cash).toEqual({ total: 175_000, reserved: 0, free: 175_000 });
    expect(await walletOf(db, bruno)).toMatchObject({ cash: 175_000 });
  }));

  it("livro 27: a venda de Ana a R$ 44,00 aberta antes do jogo continua no livro com o mesmo preço depois que o jogo começa, e executa quando uma compra a alcança", scene(async () => {
    const ana = await holder("FLA3", 10);
    const bruno = await player();
    await ready();
    const sale = accepted(await service.place(o.sellLimit(ana, "FLA3", 10, 4400, { now: new Date("2027-04-06T18:00:00Z") })));

    // Flamengo × Palmeiras começa às 16h de Brasília. O motor de ordens não olha os jogos nem os fechamentos:
    // quem muda com o jogo é a cotação da casa (T10); as ordens dos jogadores ficam como estavam.
    await insertMatch(db, { seasonId, homeClubId: club("FLA3"), awayClubId: club("PAL3"), kickoff: new Date("2027-04-06T19:00:00Z") });
    const during = new Date("2027-04-06T19:30:00Z");
    expect(await inMatch(db, seasonId, club("FLA3"), during)).toBe(true);
    expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "open", limitPrice: 4400, filled: 0 });

    const r = accepted(await service.place(o.buyLimit(bruno, "FLA3", 10, 4400, { now: during })));
    expect(r.trades.map((x) => [x.price, x.quantity, x.at])).toEqual([[4400, 10, during]]);
    expect(await orderRow(db, sale.order.id)).toMatchObject({ status: "filled", filled: 10, updatedAt: during });
  }));

  it("livro 30: depois de uma sequência de negócios com a casa, as ações de FLA3 de todas as contas e da tesouraria somam o total emitido", scene(async () => {
    await giveShares(db, treasury, club("FLA3"), 600);
    await giveCash(db, treasury, 1_000_000);
    const [ana, bruno] = [await holder("FLA3", 1_200), await holder("FLA3", 1_200)];
    await setDisplayedPrice(db, seasonId, club("FLA3"), 4200);
    await ready();
    expect((await clubRow(db, seasonId, club("FLA3"))).totalShares).toBe(3_000);
    const house = { actor: "house" as const };
    const held = async () =>
      Number((await db.execute(sql`select sum(shares)::int as n from futbolsa.positions where club_id = ${club("FLA3")}`)).rows[0]!.n);

    // três voltas da casa cotando 10 por lado (livro 23): Ana compra as 10 da casa, Bruno vende 10 à casa
    for (let turn = 0; turn < 3; turn++) {
      accepted(await service.place(o.sellLimit(treasury, "FLA3", 10, 4410, house)));
      accepted(await service.place(o.buyLimit(treasury, "FLA3", 10, 3990, house)));
      expect(accepted(await service.place(o.buyMarket(ana, "FLA3", 10))).trades.map((x) => [x.price, x.withHouse])).toEqual([[4410, true]]);
      expect(await held()).toBe(3_000);
      expect(accepted(await service.place(o.sellMarket(bruno, "FLA3", 10))).trades.map((x) => [x.price, x.withHouse])).toEqual([[3990, true]]);
      expect(await held()).toBe(3_000);
    }

    expect(await positionOf(db, treasury, club("FLA3"))).toEqual({ shares: 600, reservedShares: 0, free: 600 });
    expect(await positionOf(db, ana, club("FLA3"))).toMatchObject({ shares: 1_230 });
    expect(await positionOf(db, bruno, club("FLA3"))).toMatchObject({ shares: 1_170 });
    // a casa vendeu a R$ 44,10 e comprou a R$ 39,90: ficou com R$ 4,20 por ação em cada volta
    expect(await walletOf(db, treasury)).toEqual({ cash: 1_000_000 + 3 * 10 * 420, reservedCash: 0, free: 1_012_600, openOrders: 0 });
    expect(await tradesOf("FLA3")).toHaveLength(6);
  }));

  // ------------------------------------------------------------------ a casa e os bots

  it("a casa passa fora da faixa de 20% e do limite de 50 ordens abertas", scene(async () => {
    await giveShares(db, treasury, club("FLA3"), 60);
    await ready();
    const house = { actor: "house" as const };

    // preço exibido em R$ 40,00: a casa vende a R$ 60,00 e compra a R$ 20,00
    expect(accepted(await service.place(o.sellLimit(treasury, "FLA3", 1, 6000, house))).order.status).toBe("open");
    for (let i = 1; i <= 51; i++) accepted(await service.place(o.sellLimit(treasury, "FLA3", 1, 6000 + i, house)));
    expect(await walletOf(db, treasury)).toMatchObject({ openOrders: 52 });
    // sem caixa a casa não compra: a regra do caixa vale para ela
    expect(rejected(await service.place(o.buyLimit(treasury, "FLA3", 1, 2000, house))).code).toBe("insufficient_cash");
  }));

  it("a compra da casa fora da faixa executa contra a venda a mercado de um jogador, com with_house", scene(async () => {
    const bruno = await holder("PAL3", 10);
    await giveCash(db, treasury, 100_000);
    await setDisplayedPrice(db, seasonId, club("PAL3"), 2000);
    await ready();
    // livro 36 (a cotação é da T10): a casa compra a R$ 21,00 com o preço exibido em R$ 20,00
    accepted(await service.place(o.buyLimit(treasury, "PAL3", 10, 2100, { actor: "house" })));

    const r = accepted(await service.place(o.sellMarket(bruno, "PAL3", 10)));

    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ price: 2100, quantity: 10, withHouse: true, buyerWalletId: treasury, sellerWalletId: bruno, inAuction: false, priceBefore: 2000 });
    expect(await walletOf(db, treasury)).toEqual({ cash: 79_000, reservedCash: 0, free: 79_000, openOrders: 0 });
    expect(await positionOf(db, treasury, club("PAL3"))).toMatchObject({ shares: 10 });
  }));

  it("a ordem só é da casa com a carteira da tesouraria: trocar o ator é erro de programação, não recusa", scene(async () => {
    const ana = await player();
    await ready();
    await expect(service.place(o.buyLimit(ana, "FLA3", 1, 6000, { actor: "house" }))).rejects.toThrow(/carteira/);
    await expect(service.place(o.buyLimit(treasury, "FLA3", 1, 4000))).rejects.toThrow(/carteira/);
    await expect(service.place(o.buyLimit(ana, "FLA3", 1, 4000, { actor: "bot" }))).rejects.toThrow(/carteira/);
    await expect(service.place(o.buyLimit(ana, "XXX3", 1, 4000))).rejects.toThrow(/não listado/);
  }));

  it("a ordem do bot entra pela mesma entrada: fica no livro, executa e conta nas ordens abertas", scene(async () => {
    const bot = await openBot(db, seasonId, 1_000_000);
    const bruno = await holder("FLA3", 10);
    await ready();

    const r = accepted(await service.place(o.buyLimit(bot, "FLA3", 10, 4000, { actor: "bot", idempotencyKey: "bot-1" })));
    expect(r.order).toMatchObject({ status: "open", reservedCash: 40_000 });
    expect(await walletOf(db, bot)).toMatchObject({ reservedCash: 40_000, openOrders: 1 });
    expect(await orderRow(db, r.order.id)).toMatchObject({ idempotencyKey: "bot-1" });

    const sale = accepted(await service.place(o.sellLimit(bruno, "FLA3", 4, 3900)));
    // o negócio sai pelo preço da ordem que já estava no livro (a do bot)
    expect(sale.trades.map((t) => [t.buyerWalletId, t.quantity, t.price, t.withHouse])).toEqual([[bot, 4, 4000, false]]);
    expect(await walletOf(db, bot)).toEqual({ cash: 1_000_000 - 16_000, reservedCash: 24_000, free: 960_000, openOrders: 1 });
    expect(await orderRow(db, r.order.id)).toMatchObject({ status: "open", filled: 4, reservedCash: 24_000 });
  }));

  // ------------------------------------------------------------------ o que fica gravado

  it("a ordem a mercado sem negócio fica gravada como cancelada com market_remainder, sem mexer no caixa nem nas ações", scene(async () => {
    const ana = await holder("FLA3", 10);
    await ready();
    const before = await rowCounts(db);

    const buy = accepted(await service.place(o.buyMarket(ana, "FLA3", 5, undefined, { idempotencyKey: "k-9" })));
    expect(buy.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", filled: 0, quantity: 5, limitPrice: null, reservedCash: 0 });
    expect(buy.trades).toEqual([]);
    expect(buy.posts).toEqual([]);
    expect(buy.cash).toEqual({ total: RICH, reserved: 0, free: RICH });
    expect(await orderRow(db, buy.order.id)).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", type: "market", limitPrice: null, idempotencyKey: "k-9" });

    // a venda a mercado prende as ações na entrada e as devolve no cancelamento da sobra
    const sell = accepted(await service.place(o.sellMarket(ana, "FLA3", 10)));
    expect(sell.order).toMatchObject({ status: "cancelled", cancelReason: "market_remainder", filled: 0 });
    expect(sell.posts.map((p) => [p.entry.kind, p.entry.reservedSharesDelta])).toEqual([
      ["order_reserve", 10],
      ["order_release", -10],
    ]);
    expect(await positionOf(db, ana, club("FLA3"))).toEqual({ shares: 10, reservedShares: 0, free: 10 });
    expect(await walletOf(db, ana)).toEqual({ cash: RICH, reservedCash: 0, free: RICH, openOrders: 0 });
    expect(await rowCounts(db)).toEqual({ orders: before.orders + 2, trades: before.trades, entries: before.entries + 2 });
    expect(await price("FLA3")).toBe(4000);
  }));

  it("carteira 37: a recusa não grava nada: nem ordem, nem negócio, nem extrato, nem reserva", scene(async () => {
    const ana = await holder("FLA3", 5, 100_000);
    const bruno = await holder("FLA3", 50);
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4000)));
    const before = { counts: await rowCounts(db), wallet: await walletOf(db, ana), position: await positionOf(db, ana, club("FLA3")), price: await price("FLA3") };

    // R$ 1.000,00 livres não pagam 100 × R$ 40,00, mesmo com a venda de Bruno esperando no livro
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 100, 4000)))).toEqual({ ok: false, code: "insufficient_cash" });
    expect(rejected(await service.place(o.sellLimit(ana, "FLA3", 6, 4100)))).toEqual({ ok: false, code: "insufficient_shares" });
    expect(rejected(await service.place(o.sellMarket(ana, "FLA3", 6))).code).toBe("insufficient_shares");
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4801))).code).toBe("price_out_of_band");

    expect({ counts: await rowCounts(db), wallet: await walletOf(db, ana), position: await positionOf(db, ana, club("FLA3")), price: await price("FLA3") }).toEqual(before);
  }));

  it("a compra limitada conta só o caixa livre: com R$ 8.000,00 já reservados de R$ 10.000,00, outra de R$ 4.000,00 é recusada", scene(async () => {
    const ana = await player(1_000_000);
    await ready();
    accepted(await service.place(o.buyLimit(ana, "FLA3", 200, 4000)));
    expect(rejected(await service.place(o.buyLimit(ana, "PAL3", 100, 4000))).code).toBe("insufficient_cash");
    expect(accepted(await service.place(o.buyLimit(ana, "PAL3", 50, 4000))).cash).toEqual({ total: 1_000_000, reserved: 1_000_000, free: 0 });
  }));

  it("price_before negócio a negócio: cada negócio da mesma ordem guarda o preço exibido logo antes dele", scene(async () => {
    const sellers = [await holder("FLA3", 10), await holder("FLA3", 10), await holder("FLA3", 10)];
    const ana = await player();
    await ready();
    for (const [i, seller] of sellers.entries()) accepted(await service.place(o.sellLimit(seller, "FLA3", 10, 4010 + 10 * i)));

    const r = accepted(await service.place(o.buyLimit(ana, "FLA3", 30, 4030)));

    expect(r.trades.map((t) => [t.price, t.priceBefore, t.inAuction])).toEqual([
      [4010, 4000, false],
      [4020, 4010, false],
      [4030, 4020, false],
    ]);
    expect((await tradesOf("FLA3")).map((t) => ({ price: t.price, priceBefore: t.priceBefore, inAuction: t.inAuction, withHouse: t.withHouse, at: t.at, buyOrderId: t.buyOrderId }))).toEqual(
      [4010, 4020, 4030].map((p, i) => ({ price: p, priceBefore: i === 0 ? 4000 : p - 10, inAuction: false, withHouse: false, at: NOW, buyOrderId: r.order.id })),
    );
    expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ lastPrice: 4030, lastTradeAt: NOW });
  }));

  it("o horário do negócio nunca recua: a ordem que chega com o relógio atrás do último negócio do clube negocia no horário dele", scene(async () => {
    const bruno = await holder("FLA3", 20);
    const ana = await player();
    await ready();
    const later = new Date("2027-04-06T13:10:00Z");
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4000, { now: later })));
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4000, { now: later }))).trades.map((x) => x.at)).toEqual([later]);

    // Esta ordem leu o relógio às 10h05, antes de esperar a trava do clube, e só entrou depois do negócio das 10h10.
    const earlier = new Date("2027-04-06T13:05:00Z");
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4010, { now: earlier })));
    const r = accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4010, { now: earlier })));

    expect(r.trades.map((x) => [x.price, x.at])).toEqual([[4010, later]]);
    expect(r.posts.map((p) => p.entry.at)).toEqual([later, later, later]);
    expect(await clubRow(db, seasonId, club("FLA3"))).toMatchObject({ lastPrice: 4010, lastTradeAt: later });
    // o preço do passado (pelo horário dos negócios) concorda com o preço exibido (pela ordem da trava)
    expect(await displayedPrice(db, seasonId, "FLA3", later)).toBe(4010);
    expect(await displayedPrice(db, seasonId, "FLA3", earlier)).toBe(4000);
  }));

  it("a compra do livro executada em duas vezes: a reserva cai com cada negócio e a ordem sai das abertas quando termina", scene(async () => {
    const ana = await player(1_000_000);
    const bruno = await holder("FLA3", 100);
    await ready();
    const bid = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4000)));

    const first = accepted(await service.place(o.sellMarket(bruno, "FLA3", 30)));
    expect(first.order).toMatchObject({ status: "filled", filled: 30 });
    expect(first.bookOrders).toEqual([expect.objectContaining({ id: bid.order.id, walletId: ana, status: "open", filled: 30, reservedCash: 280_000 })]);
    expect(await walletOf(db, ana)).toEqual({ cash: 880_000, reservedCash: 280_000, free: 600_000, openOrders: 1 });

    // a venda limitada a R$ 39,00 sai a R$ 40,00, o preço da ordem que estava no livro
    const second = accepted(await service.place(o.sellLimit(bruno, "FLA3", 70, 3900)));
    expect(second.trades.map((t) => [t.quantity, t.price])).toEqual([[70, 4000]]);
    expect(second.order).toMatchObject({ status: "filled", filled: 70, reservedCash: 0 });
    expect(await orderRow(db, bid.order.id)).toMatchObject({ status: "filled", filled: 100, reservedCash: 0, updatedAt: NOW });
    expect(await walletOf(db, ana)).toEqual({ cash: 600_000, reservedCash: 0, free: 600_000, openOrders: 0 });
    expect(await walletOf(db, bruno)).toMatchObject({ cash: RICH + 400_000, openOrders: 0 });
    expect(await positionOf(db, bruno, club("FLA3"))).toEqual({ shares: 0, reservedShares: 0, free: 0 });
  }));

  it("o outro lado é lido em páginas: com 2 ordens por página, a compra atravessa 5 vendas na ordem de prioridade", scene(async () => {
    const sellers = [await holder("FLA3", 20), await holder("FLA3", 20), await holder("FLA3", 10)];
    const ana = await player(300_000);
    await ready();
    engine.pageSize = 2;
    for (let i = 0; i < 5; i++) accepted(await service.place(o.sellLimit(sellers[i % 3]!, "FLA3", 10, 4040 - 10 * i)));

    // limitada: 45 ações até R$ 40,40
    const limit = accepted(await service.place(o.buyLimit(ana, "FLA3", 45, 4040)));
    expect(limit.trades.map((t) => [t.price, t.quantity])).toEqual([[4000, 10], [4010, 10], [4020, 10], [4030, 10], [4040, 5]]);
    expect(limit.order.status).toBe("filled");
    // a mercado: as 5 que sobraram, e nada mais no livro
    const market = accepted(await service.place(o.buyMarket(ana, "FLA3", 8)));
    expect(market.trades.map((t) => [t.price, t.quantity])).toEqual([[4040, 5]]);
    expect(market.order).toMatchObject({ status: "cancelled", filled: 5 });
  }));

  // ------------------------------------------------------------------ horário e suspensão

  it("livro 21: às 9h59 do dia da estreia a ordem dá market_closed; às 10h00 é aceita", scene(async () => {
    const ana = await player();
    await ready();
    const before = await rowCounts(db);

    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4000, { now: new Date("2027-04-05T12:59:59Z") })))).toEqual({ ok: false, code: "market_closed" });
    expect(await rowCounts(db)).toEqual(before);
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 1, 4000, { now: new Date("2027-04-05T13:00:00Z") }))).order.status).toBe("open");
  }));

  it("livro 22: num domingo às 3h de Brasília a ordem é aceita", scene(async () => {
    const ana = await player();
    await ready();
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 1, 4000, { now: new Date("2027-04-11T06:00:00Z") }))).order.status).toBe("open");
  }));

  it("antes de a negociação abrir (IPO fechado) e depois do fim dela, toda ordem dá market_closed", scene(async () => {
    const ana = await player();
    await ready();
    for (const status of ["ipo_closed", "trading_ended", "closed"]) {
      await db.update(seasons).set({ status }).where(eq(seasons.id, seasonId));
      expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4000)))).toEqual({ ok: false, code: "market_closed" });
      expect(rejected(await service.place(o.buyMarket(ana, "PAL3", 1))).code).toBe("market_closed");
    }
    expect(await rowCounts(db)).toMatchObject({ orders: 0, trades: 0 });
  }));

  it("clube suspenso recusa com club_suspended e o motivo; os outros clubes seguem; o mercado todo suspenso recusa em todos", scene(async () => {
    const ana = await player();
    await ready();
    await db.update(seasonClubs).set({ suspendedReason: "Resultado em revisão" }).where(eq(seasonClubs.clubId, club("FLA3")));

    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4000)))).toEqual({ ok: false, code: "club_suspended", reason: "Resultado em revisão" });
    // nem a ordem com defeito passa na frente da suspensão
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 0, 4000))).code).toBe("club_suspended");
    expect(accepted(await service.place(o.buyLimit(ana, "PAL3", 1, 4000))).order.status).toBe("open");

    await db.update(seasons).set({ suspendedReason: "Manutenção do jogo" }).where(eq(seasons.id, seasonId));
    expect(rejected(await service.place(o.buyLimit(ana, "PAL3", 1, 4000)))).toEqual({ ok: false, code: "club_suspended", reason: "Manutenção do jogo" });
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4000)))).toEqual({ ok: false, code: "club_suspended", reason: "Manutenção do jogo" });
    expect(await db.select().from(orders)).toHaveLength(1);
  }));

  it("placeOrder roda dentro da transação de quem chama: se ela desfaz, a ordem e o negócio somem juntos", scene(async () => {
    const ana = await player();
    const bruno = await holder("FLA3", 10);
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4000)));
    const before = { counts: await rowCounts(db), ana: await walletOf(db, ana), bruno: await walletOf(db, bruno) };

    await expect(
      withTransaction(db, async (tx) => {
        const r = accepted(await service.placeOrder(tx, o.buyLimit(ana, "FLA3", 10, 4000)));
        expect(r.trades).toHaveLength(1);
        throw new Error("a rota desistiu");
      }),
    ).rejects.toThrow("a rota desistiu");

    expect({ counts: await rowCounts(db), ana: await walletOf(db, ana), bruno: await walletOf(db, bruno) }).toEqual(before);
    expect(await price("FLA3")).toBe(4000);
  }));

  it("afterWalletsLocked: a conferência de quem chama roda com a carteira travada e antes de qualquer gravação, e a recusa dela para a ordem (é onde a rota recusa a conta bloqueada)", scene(async () => {
    const ana = await player();
    const bruno = await holder("FLA3", 10);
    await ready();
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 10, 4000)));
    const before = await rowCounts(db);

    const seen: boolean[] = [];
    const blocked = await service.place(o.buyLimit(ana, "FLA3", 10, 4000), {
      hooks: {
        afterWalletsLocked: async (tx, wallet) => {
          seen.push(wallet.id === ana && tx.locks.isWalletLocked(ana));
          return { ok: false, code: "account_blocked" };
        },
      },
    });
    expect(blocked).toEqual({ ok: false, code: "account_blocked" });
    expect(seen).toEqual([true]);
    expect(await rowCounts(db)).toEqual(before);

    // a ordem que o motor já recusa antes de travar a carteira nem chega à conferência
    let calls = 0;
    const count = {
      afterWalletsLocked: async () => {
        calls++;
        return undefined;
      },
    };
    expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4801), { hooks: count })).code).toBe("price_out_of_band");
    expect(calls).toBe(0);
    // sem recusa, a ordem segue
    expect(accepted(await service.place(o.buyLimit(ana, "FLA3", 10, 4000), { hooks: count })).trades).toHaveLength(1);
    expect(calls).toBe(1);
  }));

  it("o OrderService fala com o casamento só pela porta MatchingEngine: outra implementação entra sem mudar quem chama", async () => {
    // o que a F16 faria com um serviço dedicado que guarda o livro na memória
    class ClosedEngine extends MatchingEngine {
      readonly seen: PlaceOrderInput[] = [];
      async place(_tx: Tx, input: PlaceOrderInput): Promise<PlaceOrderResult> {
        this.seen.push(input);
        return { ok: false, code: "market_closed" };
      }
    }
    const other = new ClosedEngine();
    const input = orderInputs({ seasonId, now: NOW }).buyLimit(1, "FLA3", 1, 4000);

    expect(await new OrderService(t.db, other).place(input)).toEqual({ ok: false, code: "market_closed" });
    expect(other.seen).toEqual([input]);
  });
});
