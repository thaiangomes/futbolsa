import { describe, expect, it } from "vitest";
import { MAX_OPEN_ORDERS, tradingBand, validateOrder, type OrderState } from "../src/engine/orderRules.js";

// Critérios de "Livro de ofertas e formador de mercado" das recusas que não
// dependem do casamento, e V1 a V3 do Plano do núcleo de casamento.

const state = (s: Partial<OrderState> = {}): OrderState => ({
  displayedPrice: 4000,
  cash: 1_000_000,
  availableCash: 1_000_000,
  availableShares: 1000,
  openOrders: 0,
  myOpenOrders: [],
  ...s,
});
const limit = (side: "buy" | "sell", quantity: number, limitPrice: number) => ({ side, type: "limit" as const, quantity, limitPrice });
const market = (side: "buy" | "sell", quantity: number) => ({ side, type: "market" as const, quantity });

describe("tradingBand", () => {
  it("20% em volta do preço exibido, em centavos inteiros", () => {
    expect(tradingBand(4000)).toEqual({ min: 3200, max: 4800 });
    expect(tradingBand(4800)).toEqual({ min: 3840, max: 5760 }); // livro 8
    expect(tradingBand(3500)).toEqual({ min: 2800, max: 4200 }); // livro 9
    expect(tradingBand(4333)).toEqual({ min: 3467, max: 5199 }); // arredonda para dentro da faixa
  });

  it("livro 10: o piso de R$ 0,50 vale mesmo quando o limite de baixo fica abaixo dele", () => {
    expect(tradingBand(55)).toEqual({ min: 50, max: 66 });
  });
});

describe("validateOrder", () => {
  it("livro 5: venda maior que as ações livres é recusada", () => {
    expect(validateOrder(market("sell", 800), state({ availableShares: 700 }))).toEqual({ ok: false, code: "insufficient_shares" });
    expect(validateOrder(market("sell", 200), state({ availableShares: 700 }))).toEqual({ ok: true, marketPriceLimit: 3200 });
  });

  it("livro 6: limitada a mais de 20% do preço exibido é recusada; no limite, aceita", () => {
    expect(validateOrder(limit("buy", 1, 4801), state())).toEqual({ ok: false, code: "price_out_of_band" });
    expect(validateOrder(limit("sell", 1, 3199), state())).toEqual({ ok: false, code: "price_out_of_band" });
    expect(validateOrder(limit("buy", 1, 4800), state()).ok).toBe(true);
    expect(validateOrder(limit("sell", 1, 3200), state()).ok).toBe(true);
  });

  it("livro 8: o limite anda com o negócio, mesmo longe do valor justo da casa", () => {
    expect(validateOrder(limit("buy", 1, 5700), state({ displayedPrice: 4800 })).ok).toBe(true);
  });

  it("livro 9: antes do primeiro negócio, a faixa é em volta do preço do IPO", () => {
    expect(validateOrder(limit("buy", 1, 2800), state({ displayedPrice: 3500 })).ok).toBe(true);
    expect(validateOrder(limit("buy", 1, 4200), state({ displayedPrice: 3500 })).ok).toBe(true);
    expect(validateOrder(limit("buy", 1, 4201), state({ displayedPrice: 3500 })).ok).toBe(false);
  });

  it("livro 10: venda a R$ 0,49 é recusada pelo piso; a R$ 0,50, aceita", () => {
    expect(validateOrder(limit("sell", 1, 49), state({ displayedPrice: 55 }))).toEqual({ ok: false, code: "below_min_price" });
    expect(validateOrder(limit("sell", 1, 50), state({ displayedPrice: 55 })).ok).toBe(true);
  });

  it("livro 11: com o preço a R$ 35,00, uma compra nova a R$ 47,00 é recusada", () => {
    expect(validateOrder(limit("buy", 1, 4700), state({ displayedPrice: 3500 }))).toEqual({ ok: false, code: "price_out_of_band" });
  });

  it("livro 13: ordem contra si mesmo é recusada", () => {
    const myOpenOrders = [{ side: "sell" as const, limitPrice: 4200 }];
    expect(validateOrder(limit("buy", 1, 4200), state({ myOpenOrders }))).toEqual({ ok: false, code: "self_trade" });
    expect(validateOrder(market("buy", 1), state({ myOpenOrders }))).toEqual({ ok: false, code: "self_trade" });
    expect(validateOrder(limit("buy", 1, 4199), state({ myOpenOrders })).ok).toBe(true);
    // Uma compra minha não impede outra compra.
    expect(validateOrder(market("buy", 1), state({ myOpenOrders: [{ side: "buy", limitPrice: 3900 }] })).ok).toBe(true);
  });

  it("livro 14: quantidade zero ou fracionada e preço fora dos centavos são recusados", () => {
    expect(validateOrder(limit("buy", 0, 4000), state())).toEqual({ ok: false, code: "invalid_quantity" });
    expect(validateOrder(limit("buy", 1.5, 4000), state())).toEqual({ ok: false, code: "invalid_quantity" });
    expect(validateOrder(limit("buy", 1, 4000.5), state())).toEqual({ ok: false, code: "invalid_price" });
    expect(validateOrder(market("buy", -3), state())).toEqual({ ok: false, code: "invalid_quantity" });
  });

  it(`livro 15: com ${MAX_OPEN_ORDERS} ordens abertas, a seguinte limitada é recusada; com uma a menos, aceita`, () => {
    expect(validateOrder(limit("buy", 1, 4000), state({ openOrders: 50 }))).toEqual({ ok: false, code: "too_many_open_orders" });
    expect(validateOrder(limit("buy", 1, 4000), state({ openOrders: 49 })).ok).toBe(true);
    // A ordem a mercado nunca fica aberta, então não conta.
    expect(validateOrder(market("buy", 1), state({ openOrders: 50 })).ok).toBe(true);
  });

  it("livro 17: com o caixa negativo, compra é recusada e venda é aceita", () => {
    const negative = state({ cash: -25_000, availableCash: -25_000 });
    expect(validateOrder(market("buy", 1), negative)).toEqual({ ok: false, code: "negative_cash" });
    expect(validateOrder(limit("buy", 1, 4000), negative)).toEqual({ ok: false, code: "negative_cash" });
    expect(validateOrder(market("sell", 100), negative).ok).toBe(true);
  });

  it("compra limitada maior que o caixa livre é recusada; a mercado passa (executa até o livre)", () => {
    expect(validateOrder(limit("buy", 100, 4000), state({ availableCash: 399_999 }))).toEqual({ ok: false, code: "insufficient_cash" });
    expect(validateOrder(limit("buy", 100, 4000), state({ availableCash: 400_000 })).ok).toBe(true);
    expect(validateOrder(market("buy", 100), state({ availableCash: 10 })).ok).toBe(true);
  });

  it("V1: com mais de um motivo, vale a ordem formato → caixa negativo → faixa → 50 ordens → saldo → contra si mesmo", () => {
    const all = state({ cash: -1, availableCash: -1, openOrders: 50, availableShares: 0, myOpenOrders: [{ side: "sell", limitPrice: 100 }] });
    expect(validateOrder(limit("buy", 0, 99_999), all)).toMatchObject({ code: "invalid_quantity" });
    expect(validateOrder(limit("buy", 1, 99_999), all)).toMatchObject({ code: "negative_cash" });
    expect(validateOrder(limit("sell", 1, 99_999), all)).toMatchObject({ code: "price_out_of_band" });
    expect(validateOrder(limit("sell", 1, 4000), all)).toMatchObject({ code: "too_many_open_orders" });
    expect(validateOrder(market("sell", 1), all)).toMatchObject({ code: "insufficient_shares" });
    expect(validateOrder(market("sell", 1), { ...all, availableShares: 5, myOpenOrders: [{ side: "buy", limitPrice: 100 }] })).toMatchObject({ code: "self_trade" });
  });

  it("V2: a ordem a mercado aprovada volta com o limite de preço (teto na compra, piso na venda)", () => {
    expect(validateOrder(market("buy", 1), state())).toEqual({ ok: true, marketPriceLimit: 4800 });
    expect(validateOrder(market("sell", 1), state())).toEqual({ ok: true, marketPriceLimit: 3200 });
    expect(validateOrder(limit("buy", 1, 4000), state())).toEqual({ ok: true });
  });

  it("V3: a casa não passa pela faixa de 20% nem pelo limite de 50 ordens", () => {
    const house = state({ isHouse: true, openOrders: 500 });
    expect(validateOrder(limit("sell", 1, 2000), house)).toEqual({ ok: true });
    expect(validateOrder(market("buy", 1), house)).toEqual({ ok: true });
  });

  it("quantidade × preço que não cabe num inteiro seguro é recusada", () => {
    expect(validateOrder(limit("buy", 2 ** 50, 4000), state({ displayedPrice: 4000 }))).toEqual({ ok: false, code: "invalid_quantity" });
  });
});
