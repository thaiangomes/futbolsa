import { describe, expect, it } from "vitest";
import { aggregateBook, toPublicTrades } from "../../src/modules/market/index.js";

// T3 do Plano do livro de ofertas e formador: a agregação pura do livro e dos últimos negócios.

describe("aggregateBook", () => {
  it("livro 18: vendas em 7 preços viram 5 níveis com quantidade somada e número de ordens, sem dono", () => {
    const open = [
      { side: "sell" as const, limitPrice: 4500, remaining: 10 },
      { side: "sell" as const, limitPrice: 4410, remaining: 10 },
      { side: "sell" as const, limitPrice: 4430, remaining: 50 },
      { side: "sell" as const, limitPrice: 4430, remaining: 20 }, // mesmo preço: soma e conta
      { side: "sell" as const, limitPrice: 4460, remaining: 5 },
      { side: "sell" as const, limitPrice: 4470, remaining: 5 },
      { side: "sell" as const, limitPrice: 4480, remaining: 5 },
      { side: "sell" as const, limitPrice: 4490, remaining: 5 },
    ];
    const { asks, bids } = aggregateBook(open);
    expect(bids).toEqual([]);
    expect(asks).toEqual([
      { price: 4410, quantity: 10, orders: 1 },
      { price: 4430, quantity: 70, orders: 2 },
      { price: 4460, quantity: 5, orders: 1 },
      { price: 4470, quantity: 5, orders: 1 },
      { price: 4480, quantity: 5, orders: 1 },
    ]);
    for (const level of asks) expect(Object.keys(level).sort()).toEqual(["orders", "price", "quantity"]);
  });

  it("as compras vêm do maior preço para o menor, e a quantidade é o que falta executar", () => {
    const { bids } = aggregateBook([
      { side: "buy", limitPrice: 3900, remaining: 5 },
      { side: "buy", limitPrice: 4000, remaining: 40 },
      { side: "buy", limitPrice: 4000, remaining: 60 },
    ]);
    expect(bids).toEqual([
      { price: 4000, quantity: 100, orders: 2 },
      { price: 3900, quantity: 5, orders: 1 },
    ]);
  });

  it("o livro vazio dá dois lados vazios, e a profundidade é ajustável", () => {
    expect(aggregateBook([])).toEqual({ bids: [], asks: [] });
    const many = Array.from({ length: 9 }, (_, i) => ({ side: "buy" as const, limitPrice: 1000 + i, remaining: 1 }));
    expect(aggregateBook(many, 2).bids).toHaveLength(2);
  });
});

describe("toPublicTrades", () => {
  it("livro 19: dos 30 negócios do dia saem os 20 mais recentes, sem comprador nem vendedor", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      at: new Date(Date.UTC(2027, 3, 5, 13, i)),
      price: 4000 + i,
      quantity: 10,
      buyerWalletId: 7,
      sellerWalletId: 8,
      withHouse: i % 2 === 0,
    }));
    const shown = toPublicTrades(rows);
    expect(shown).toHaveLength(20);
    expect(shown[0]).toEqual({ id: 30, at: "2027-04-05T13:29:00.000Z", price: 4029, quantity: 10 });
    expect(shown[19]!.id).toBe(11);
    for (const trade of shown) expect(Object.keys(trade).sort()).toEqual(["at", "id", "price", "quantity"]);
  });

  it("negócios no mesmo instante saem do de maior id para o de menor", () => {
    const at = new Date("2027-04-05T13:00:00Z");
    const shown = toPublicTrades([
      { id: 1, at, price: 4000, quantity: 1 },
      { id: 3, at, price: 4100, quantity: 1 },
      { id: 2, at, price: 4050, quantity: 1 },
    ]);
    expect(shown.map((t) => t.id)).toEqual([3, 2, 1]);
  });
});
