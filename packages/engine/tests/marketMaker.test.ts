import { describe, expect, it } from "vitest";
import { Ledger } from "../src/engine/ledger.js";
import { computeQuote, DEFAULT_MARKET_MAKER, MarketMaker, quoteSize } from "../src/engine/marketMaker.js";
import { Exchange } from "../src/engine/orderbook.js";
import { tradingBand } from "../src/engine/orderRules.js";
import { Rng } from "../src/sim/rng.js";

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

describe("faixa da casa em conta inteira", () => {
  it("livro 24: no modo de jogo, com valor justo de R$ 42,00, a casa compra a R$ 39,06 e vende a R$ 44,94", () => {
    expect(computeQuote(4200, true, RICH, 1000, FAIR, { quantity: 24 })).toEqual({
      bid: { price: 3906, quantity: 24 },
      ask: { price: 4494, quantity: 24 },
    });
  });

  it("livro 26: faixa de 14% no jogo e de 10% depois do placar, com o valor justo novo de R$ 43,20", () => {
    expect(computeQuote(4200, true, RICH, 1000, FAIR, { quantity: 1 })).toMatchObject({ bid: { price: 3906 }, ask: { price: 4494 } });
    expect(computeQuote(4320, false, RICH, 1000, FAIR, { quantity: 7 })).toMatchObject({ bid: { price: 4104 }, ask: { price: 4536 } });
  });

  it("Q1: de R$ 0,50 a R$ 2.000,00, dentro e fora de jogo, compra e venda iguais à conta exata", () => {
    const wrong: unknown[] = [];
    for (let ref = 50; ref <= 200_000; ref++) {
      for (const inMatch of [false, true]) {
        const bp = BigInt(inMatch ? 1400 : 1000);
        const r = BigInt(ref);
        let bid = Math.max(50, Number((r * (20_000n - bp)) / 20_000n));
        let ask = Math.max(50, Number((r * (20_000n + bp) + 19_999n) / 20_000n));
        if (ask <= bid) ask = bid + 1;
        if (bid >= ref && ref > 50) bid = ref - 1;
        const q = computeQuote(ref, inMatch, RICH, 1000, FAIR, { quantity: 1 });
        if (q.bid!.price !== bid || q.ask!.price !== ask) wrong.push({ ref, inMatch, got: [q.bid!.price, q.ask!.price], want: [bid, ask] });
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(wrong).toHaveLength(0);
  });
});

describe("casa nunca melhor que o mercado", () => {
  /** Tesouraria com caixa e ações e um livro com preço exibido; a casa cota em volta do valor justo `fair`. */
  function market(displayed: number, fair: number) {
    const ledger = new Ledger();
    ledger.open("casa", RICH);
    ledger.adjustShares("casa", "FLA3", 1000);
    for (const id of ["ana", "bruno"]) {
      ledger.open(id, 1_000_000);
      ledger.adjustShares(id, "FLA3", 100);
    }
    const ex = new Exchange(ledger, { houseAccounts: ["casa"], selfTrade: "reject" });
    ex.setReferencePrice("FLA3", displayed);
    const mm = new MarketMaker(ex, ledger, "casa", FAIR, () => fair);
    return { ledger, ex, mm };
  }

  it("livro 12: com preço de R$ 60,00 e valor justo de R$ 30,00, vende a R$ 57,00, compra a R$ 28,50 e a bolha desce aos poucos", () => {
    expect(computeQuote(3000, false, RICH, 1000, FAIR, { quantity: 7, displayedPrice: 6000 })).toEqual({
      bid: { price: 2850, quantity: 7 },
      ask: { price: 5700, quantity: 7 },
    });
    const { ex, mm } = market(6000, 3000);
    mm.refresh("FLA3", false);
    expect(ex.bestAsk("FLA3")?.limitPrice).toBe(5700);
    expect(ex.bestBid("FLA3")?.limitPrice).toBe(2850);
    const r = ex.placeOrder({ accountId: "ana", clubId: "FLA3", side: "buy", type: "limit", quantity: 5, limitPrice: 5800 });
    expect(r.trades.map((t) => [t.sellerId, t.price])).toEqual([["casa", 5700]]);
    expect(ex.price("FLA3")).toBe(5700);
    mm.refresh("FLA3", false);
    expect(ex.bestAsk("FLA3")?.limitPrice).toBe(5415);
  });

  it("livro 36: com preço de R$ 20,00 e valor justo de R$ 40,00, compra a R$ 21,00 e vende a R$ 42,00", () => {
    const { ex, mm } = market(2000, 4000);
    mm.refresh("FLA3", false);
    expect(ex.bestBid("FLA3")?.limitPrice).toBe(2100);
    expect(ex.bestAsk("FLA3")?.limitPrice).toBe(4200);
    const r = ex.placeOrder({ accountId: "bruno", clubId: "FLA3", side: "sell", type: "market", quantity: 10, marketPriceLimit: tradingBand(2000).min });
    expect(r.trades.map((t) => [t.buyerId, t.quantity, t.price])).toEqual([["casa", 10, 2100]]);
  });

  it("livro 37: no modo de jogo, a mesma margem de 5%: vende a R$ 57,00 e compra a R$ 27,90", () => {
    expect(computeQuote(3000, true, RICH, 1000, FAIR, { quantity: 1, displayedPrice: 6000 })).toMatchObject({
      bid: { price: 2790 },
      ask: { price: 5700 },
    });
  });

  it("livro 25 e exemplo: perto do valor justo nada muda", () => {
    // A casa vendeu as 7 a R$ 44,10 e o preço exibido foi a R$ 44,10; às 12h ela volta a vender a R$ 44,10.
    expect(computeQuote(4200, false, RICH, 1000, FAIR, { quantity: 7, displayedPrice: 4410 })).toEqual(
      computeQuote(4200, false, RICH, 1000, FAIR, { quantity: 7 }),
    );
    // Exemplo da especificação: preço a R$ 44,30, jogo começando, valor justo de R$ 42,00.
    expect(computeQuote(4200, true, RICH, 1000, FAIR, { quantity: 1, displayedPrice: 4430 })).toMatchObject({ bid: { price: 3906 }, ask: { price: 4494 } });
  });

  it("M1 a M3: perto do valor justo a margem não age; a venda sempre acima da compra; a casa nunca do lado da vantagem fora da faixa de 20%", () => {
    const rng = new Rng(9);
    const wrong: unknown[] = [];
    for (let i = 0; i < 20_000; i++) {
      const fair = rng.int(50, 200_000);
      const inMatch = rng.chance(0.3);
      const near = Math.max(50, Math.round(fair * rng.uniform(0.91, 1.1)));
      const far = Math.max(50, Math.round(fair * rng.uniform(0.2, 5)));
      // M1 (fora de jogo, onde a faixa é de 10%).
      if (!inMatch) {
        const plain = computeQuote(fair, false, RICH, 1000, FAIR, { quantity: 1 });
        const q = computeQuote(fair, false, RICH, 1000, FAIR, { quantity: 1, displayedPrice: near });
        if (q.bid!.price !== plain.bid!.price || q.ask!.price !== plain.ask!.price) wrong.push({ m: "M1", fair, near, q, plain });
      }
      const q = computeQuote(fair, inMatch, RICH, 1000, FAIR, { quantity: 1, displayedPrice: far });
      const band = tradingBand(far);
      if (!(q.ask!.price > q.bid!.price && q.bid!.price >= 50)) wrong.push({ m: "M2", fair, far, q });
      if (!(q.ask!.price >= band.min && q.bid!.price <= band.max)) wrong.push({ m: "M3", fair, far, q, band });
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it("sem a margem na configuração (rodadas antigas), a cotação é só pelo valor justo", () => {
    const { marketMargin: _, ...noMargin } = FAIR;
    expect(computeQuote(3000, false, RICH, 1000, noMargin, { quantity: 7, displayedPrice: 6000 })).toEqual({
      bid: { price: 2850, quantity: 7 },
      ask: { price: 3150, quantity: 7 },
    });
  });
});
