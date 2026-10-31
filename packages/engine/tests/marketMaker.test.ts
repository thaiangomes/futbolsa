import { describe, expect, it } from "vitest";
import { computeQuote, DEFAULT_MARKET_MAKER, quoteSize } from "../src/engine/marketMaker.js";

// Cotação da casa: critérios 23, 24, 29 e 34 de "Livro de ofertas e formador de mercado".

const FAIR = DEFAULT_MARKET_MAKER;
const RICH = 100_000_000; // tesouraria com caixa de sobra

describe("quantidade da casa", () => {
  it("livro 23: 0,25% de 3.000 ações são 7 por lado, a R$ 39,90 e R$ 44,10 com valor justo de R$ 42,00", () => {
    expect(quoteSize(3000, 25)).toBe(7);
    expect(computeQuote(4200, false, RICH, 1000, FAIR, { quantity: quoteSize(3000, 25) })).toEqual({
      bid: { price: 3990, quantity: 7 },
      ask: { price: 4410, quantity: 7 },
    });
  });

  it("livro 24: 41.250 ações dão 103 por lado fora de jogo e 24 no modo de jogo", () => {
    expect(quoteSize(41_250, 25)).toBe(103);
    expect(quoteSize(41_250, 6)).toBe(24);
    expect(computeQuote(4200, false, RICH, 1000, FAIR, { quantity: 103 })).toMatchObject({ bid: { quantity: 103 }, ask: { quantity: 103 } });
    expect(computeQuote(4200, true, RICH, 1000, FAIR, { quantity: 24 })).toMatchObject({ bid: { quantity: 24 }, ask: { quantity: 24 } });
  });

  it("livro 34: com 1%, um clube de 3.000 ações tem 30 por lado", () => {
    expect(quoteSize(3000, 100)).toBe(30);
  });

  it("pelo menos 1 ação, e o mínimo por lado quando houver", () => {
    expect(quoteSize(100, 6)).toBe(1);
    expect(quoteSize(3000, 6)).toBe(1);
    expect(quoteSize(3000, 25, 20)).toBe(20);
    expect(quoteSize(41_250, 25, 20)).toBe(103);
  });

  it("sem a quantidade de fora, continua com 100 e 25 da configuração (simulação)", () => {
    expect(computeQuote(4200, false, RICH, 1000, FAIR)).toMatchObject({ bid: { quantity: 100 }, ask: { quantity: 100 } });
    expect(computeQuote(4200, true, RICH, 1000, FAIR)).toMatchObject({ bid: { quantity: 25 }, ask: { quantity: 25 } });
  });

  it("livro 29: só cota o que a tesouraria tem", () => {
    // Sem ações livres, só a compra.
    expect(computeQuote(4200, false, RICH, 0, FAIR, { quantity: 7 })).toEqual({ bid: { price: 3990, quantity: 7 } });
    // Com R$ 200,00 e a compra a R$ 39,90, compra 5; a venda fica normal.
    expect(computeQuote(4200, false, 20_000, 1000, FAIR, { quantity: 7 })).toEqual({
      bid: { price: 3990, quantity: 5 },
      ask: { price: 4410, quantity: 7 },
    });
    // Sem caixa, só a venda.
    expect(computeQuote(4200, false, 0, 1000, FAIR, { quantity: 7 })).toEqual({ ask: { price: 4410, quantity: 7 } });
  });
});
