import { beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/engine/ledger.js";
import { computeQuote, DEFAULT_MARKET_MAKER, MarketMaker } from "../src/engine/marketMaker.js";
import { Exchange } from "../src/engine/orderbook.js";

const CLUB = "FLA3";

function setup() {
  const ledger = new Ledger();
  for (const id of ["ana", "bia", "caio", "duda"]) {
    ledger.open(id, 100_000); // R$ 1.000,00
    ledger.adjustShares(id, CLUB, 100);
  }
  const exchange = new Exchange(ledger, { houseAccounts: ["casa"], houseTradesSetPrice: false });
  exchange.setReferencePrice(CLUB, 1000);
  return { ledger, exchange };
}

describe("Exchange", () => {
  let ledger: Ledger;
  let exchange: Exchange;
  beforeEach(() => ({ ledger, exchange } = setup()));

  const limit = (accountId: string, side: "buy" | "sell", quantity: number, limitPrice: number) =>
    exchange.placeOrder({ accountId, clubId: CLUB, side, type: "limit", quantity, limitPrice });
  const market = (accountId: string, side: "buy" | "sell", quantity: number) =>
    exchange.placeOrder({ accountId, clubId: CLUB, side, type: "market", quantity });

  it("ordem limitada sem contraparte fica no livro e reserva o dinheiro", () => {
    const r = limit("ana", "buy", 10, 950);
    expect(r.status).toBe("resting");
    expect(ledger.availableCash("ana")).toBe(100_000 - 9_500);
    expect(exchange.bestBid(CLUB)?.limitPrice).toBe(950);
  });

  it("casa pelo preço da ordem que já estava no livro", () => {
    limit("ana", "sell", 10, 1000);
    const r = limit("bia", "buy", 10, 1100);
    expect(r.status).toBe("filled");
    expect(r.trades[0]).toMatchObject({ price: 1000, quantity: 10, buyerId: "bia", sellerId: "ana" });
    // A reserva pelo limite (R$ 110) é devolvida; só sai o valor do negócio.
    expect(ledger.get("bia").cash).toBe(100_000 - 10_000);
    expect(ledger.get("bia").reservedCash).toBe(0);
    expect(ledger.shares("bia", CLUB)).toBe(110);
    expect(ledger.get("ana").cash).toBe(110_000);
    expect(ledger.shares("ana", CLUB)).toBe(90);
    expect(exchange.price(CLUB)).toBe(1000);
  });

  it("respeita prioridade de preço e depois de tempo", () => {
    limit("ana", "sell", 5, 1010); // pior preço
    limit("bia", "sell", 5, 1000); // melhor preço, chegou depois da ana
    limit("caio", "sell", 5, 1000); // mesmo preço da bia, chegou depois
    const r = market("duda", "buy", 8);
    expect(r.trades.map((t) => [t.sellerId, t.price, t.quantity])).toEqual([
      ["bia", 1000, 5],
      ["caio", 1000, 3],
    ]);
    expect(exchange.bestAsk(CLUB)).toMatchObject({ accountId: "caio", remaining: 2 });
  });

  it("ordem a mercado percorre vários preços e o que sobra é cancelado", () => {
    limit("ana", "sell", 5, 1000);
    limit("bia", "sell", 5, 1200);
    const r = market("caio", "buy", 20);
    expect(r.status).toBe("partial");
    expect(r.trades.reduce((s, t) => s + t.quantity, 0)).toBe(10);
    expect(exchange.openOrders("caio")).toEqual([]);
  });

  it("compra a mercado nunca gasta mais do que o saldo livre", () => {
    ledger.adjustShares("ana", CLUB, 1000);
    limit("ana", "sell", 1000, 1000); // R$ 10.000 em ações, bia só tem R$ 1.000
    const r = market("bia", "buy", 1000);
    expect(r.trades[0]!.quantity).toBe(100);
    expect(ledger.get("bia").cash).toBe(0);
    expect(ledger.get("bia").cash).toBeGreaterThanOrEqual(0);
  });

  it("rejeita compra limitada sem saldo e venda sem ações", () => {
    expect(limit("ana", "buy", 1000, 1000).status).toBe("rejected");
    expect(limit("ana", "sell", 101, 1000).status).toBe("rejected");
    // As ações já presas numa venda aberta não podem ser vendidas de novo.
    limit("ana", "sell", 80, 1000);
    expect(market("ana", "sell", 30).status).toBe("rejected");
  });

  it("rejeita preço abaixo do mínimo de R$ 0,50", () => {
    expect(limit("ana", "sell", 1, 49).status).toBe("rejected");
    expect(limit("ana", "sell", 1, 50).status).toBe("resting");
  });

  it("cancelar devolve o que estava reservado", () => {
    const buy = limit("ana", "buy", 10, 900);
    const sell = limit("ana", "sell", 10, 1100);
    exchange.cancelOrder(buy.order!.id);
    exchange.cancelOrder(sell.order!.id);
    expect(ledger.availableCash("ana")).toBe(100_000);
    expect(ledger.availableShares("ana", CLUB)).toBe(100);
  });

  it("não deixa uma conta negociar com ela mesma", () => {
    limit("ana", "sell", 10, 1000);
    const r = limit("ana", "buy", 10, 1000);
    expect(r.trades).toEqual([]);
    expect(r.status).toBe("resting");
  });

  it("dinheiro e ações se conservam depois de muitos negócios", () => {
    const cashBefore = ledger.totalCash();
    limit("ana", "sell", 30, 1000);
    limit("bia", "buy", 10, 1000);
    market("caio", "buy", 15);
    limit("duda", "buy", 20, 990);
    market("bia", "sell", 25);
    expect(ledger.totalCash()).toBe(cashBefore);
    expect(ledger.totalShares(CLUB)).toBe(400);
    for (const a of ledger.all()) {
      expect(a.cash).toBeGreaterThanOrEqual(a.reservedCash);
      for (const p of a.positions.values()) expect(p.shares).toBeGreaterThanOrEqual(p.reserved);
    }
  });

  it("com houseTradesSetPrice=false, negócio com a casa não muda o preço exibido", () => {
    ledger.open("casa", 0);
    ledger.adjustShares("casa", CLUB, 50);
    limit("casa", "sell", 10, 1500);
    market("ana", "buy", 10);
    expect(exchange.lastTradePrice(CLUB)).toBe(1500);
    expect(exchange.price(CLUB)).toBe(1000);
  });
});

describe("MarketMaker", () => {
  it("cota perto do último preço com spread de ~2%", () => {
    expect(computeQuote(1000, false, 1_000_000, 1000)).toEqual({
      bid: { price: 990, quantity: 100 },
      ask: { price: 1010, quantity: 100 },
    });
  });

  it("amplia o spread e reduz a quantidade durante os jogos do clube", () => {
    expect(computeQuote(1000, true, 1_000_000, 1000)).toEqual({
      bid: { price: 970, quantity: 25 },
      ask: { price: 1030, quantity: 25 },
    });
  });

  it("só cota o que a tesouraria tem", () => {
    const q = computeQuote(1000, false, 4_950, 0);
    expect(q.bid).toEqual({ price: 990, quantity: 5 });
    expect(q.ask).toBeUndefined();
  });

  it("nunca cota abaixo de R$ 0,50", () => {
    const q = computeQuote(50, true, 1_000_000, 100);
    expect(q.bid!.price).toBeGreaterThanOrEqual(50);
    expect(q.ask!.price).toBeGreaterThan(q.bid!.price);
  });

  it("refresh troca as cotações antigas pelas novas", () => {
    const { ledger, exchange } = setup();
    ledger.open("casa", 1_000_000);
    ledger.adjustShares("casa", CLUB, 500);
    const mm = new MarketMaker(exchange, ledger, "casa");
    mm.refresh(CLUB, false);
    mm.refresh(CLUB, false);
    expect(exchange.openOrders("casa")).toHaveLength(2);
    expect(exchange.bestBid(CLUB)?.limitPrice).toBe(990);
    expect(exchange.bestAsk(CLUB)?.limitPrice).toBe(1010);
  });
  it("com a âncora fair cota em volta do valor justo, não do último negócio", () => {
    const { ledger, exchange } = setup();
    ledger.open("casa", 1_000_000);
    ledger.adjustShares("casa", CLUB, 500);
    const mm = new MarketMaker(exchange, ledger, "casa", { ...DEFAULT_MARKET_MAKER, anchor: "fair" }, () => 2000);
    mm.refresh(CLUB, false);
    expect(exchange.bestBid(CLUB)?.limitPrice).toBe(1980);
    expect(exchange.bestAsk(CLUB)?.limitPrice).toBe(2020);
  });
});
