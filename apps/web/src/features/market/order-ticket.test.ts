import { describe, expect, it } from "vitest";
import { MARKET_ERROR_MESSAGES, ORDER_REJECT_CODES } from "@futbolsa/contracts";
import { marketErrorMessage, newIdempotencyKey, reviewTicket, type TicketContext } from "./order-ticket";

// W3 do Plano do livro de ofertas e formador: a boleta confere no navegador com o mesmo `validateOrder` do motor, antes de enviar.

const ctx = (over: Partial<TicketContext> = {}): TicketContext => ({
  displayedPrice: 4000,
  cash: 1_000_000,
  freeCash: 1_000_000,
  freeShares: 1200,
  openOrders: 0,
  myOpenOrders: [],
  inAuction: false,
  inMatch: false,
  ...over,
});
const form = (over: Partial<{ side: "buy" | "sell"; type: "limit" | "market"; quantity: string; price: string }> = {}) => ({
  side: "buy" as const,
  type: "limit" as const,
  quantity: "100",
  price: "40,00",
  ...over,
});

describe("reviewTicket", () => {
  it("livro 1: compra limitada de 100 a R$ 40,00 reserva R$ 4.000,00", () => {
    const r = reviewTicket(form(), ctx({ freeCash: 1_000_000 }));
    expect(r).toMatchObject({ ok: true, order: { side: "buy", type: "limit", quantity: 100, limitPrice: 4000 }, total: 400_000, reserve: 400_000 });
  });

  it("livro 6: a R$ 48,01 é recusada com a mensagem da faixa; a R$ 48,00 passa", () => {
    expect(reviewTicket(form({ price: "48,01" }), ctx())).toEqual({ ok: false, code: "price_out_of_band", message: MARKET_ERROR_MESSAGES.price_out_of_band });
    expect(reviewTicket(form({ price: "48,00" }), ctx()).ok).toBe(true);
    expect(reviewTicket(form({ side: "sell", price: "31,99" }), ctx())).toMatchObject({ ok: false, code: "price_out_of_band" });
    expect(reviewTicket(form({ side: "sell", price: "32,00" }), ctx()).ok).toBe(true);
  });

  it("livro 14: quantidade 0, 1,5 ou preço de R$ 40,005 dão a mensagem do motor, na mesma ordem da API", () => {
    expect(reviewTicket(form({ quantity: "0" }), ctx())).toMatchObject({ ok: false, code: "invalid_quantity" });
    expect(reviewTicket(form({ quantity: "1,5" }), ctx())).toMatchObject({ ok: false, code: "invalid_quantity" });
    expect(reviewTicket(form({ quantity: "" }), ctx())).toMatchObject({ ok: false, code: "invalid_quantity" });
    expect(reviewTicket(form({ price: "40,005" }), ctx())).toMatchObject({ ok: false, code: "invalid_price" });
    expect(reviewTicket(form({ price: "" }), ctx())).toMatchObject({ ok: false, code: "invalid_price" });
  });

  it("livro 10: R$ 0,49 é recusado pelo piso e R$ 0,50 passa", () => {
    expect(reviewTicket(form({ side: "sell", price: "0,49" }), ctx({ displayedPrice: 55 }))).toMatchObject({ ok: false, code: "below_min_price" });
    expect(reviewTicket(form({ side: "sell", price: "0,50" }), ctx({ displayedPrice: 55 })).ok).toBe(true);
  });

  it("compra maior que o caixa livre e venda maior que as ações livres são recusadas", () => {
    expect(reviewTicket(form({ quantity: "100", price: "40,00" }), ctx({ freeCash: 399_999 }))).toMatchObject({ ok: false, code: "insufficient_cash" });
    expect(reviewTicket(form({ side: "sell", quantity: "1201" }), ctx({ freeShares: 1200 }))).toMatchObject({ ok: false, code: "insufficient_shares" });
    expect(reviewTicket(form({ side: "sell", quantity: "1200", price: "40,00" }), ctx({ freeShares: 1200 })).ok).toBe(true);
  });

  it("livro 13: ordem contra si mesmo é recusada", () => {
    const mine = [{ side: "sell" as const, limitPrice: 4200 }];
    expect(reviewTicket(form({ price: "42,00" }), ctx({ myOpenOrders: mine }))).toMatchObject({ ok: false, code: "self_trade" });
    expect(reviewTicket(form({ price: "41,99" }), ctx({ myOpenOrders: mine })).ok).toBe(true);
    expect(reviewTicket(form({ type: "market", price: "" }), ctx({ myOpenOrders: mine }))).toMatchObject({ ok: false, code: "self_trade" });
  });

  it("livro 15: com 50 ordens abertas a limitada é recusada; a mercado passa", () => {
    expect(reviewTicket(form(), ctx({ openOrders: 50 }))).toMatchObject({ ok: false, code: "too_many_open_orders" });
    expect(reviewTicket(form({ type: "market", price: "" }), ctx({ openOrders: 50 })).ok).toBe(true);
  });

  it("livro 17: com o caixa negativo a compra é recusada e a venda passa", () => {
    expect(reviewTicket(form(), ctx({ cash: -25_000, freeCash: -25_000 }))).toMatchObject({ ok: false, code: "negative_cash" });
    expect(reviewTicket(form({ side: "sell" }), ctx({ cash: -25_000, freeCash: -25_000 })).ok).toBe(true);
  });

  it("livro 41: ordem a mercado em leilão é recusada com o motivo, e a limitada passa dentro dos 20%", () => {
    expect(reviewTicket(form({ type: "market", price: "" }), ctx({ inAuction: true }))).toMatchObject({ ok: false, code: "club_in_auction" });
    expect(reviewTicket(form({ price: "48,01" }), ctx({ inAuction: true }))).toMatchObject({ ok: false, code: "price_out_of_band" });
    expect(reviewTicket(form({ price: "47,00" }), ctx({ inAuction: true })).ok).toBe(true);
  });

  it("a ordem a mercado de compra não reserva e a de venda reserva as ações; o aviso de jogo vem da tela do clube", () => {
    const buy = reviewTicket(form({ type: "market", price: "" }), ctx({ inMatch: true }));
    expect(buy).toMatchObject({ ok: true, order: { type: "market", quantity: 100 }, reserve: 0, inMatch: true });
    expect((buy as { order: Record<string, unknown> }).order.limitPrice).toBeUndefined();
    const sell = reviewTicket(form({ side: "sell", type: "market", price: "" }), ctx());
    expect(sell).toMatchObject({ ok: true, reserve: 0, reservedShares: 100 });
  });

  it("o que o jogador digita com vírgula, ponto e R$ é entendido", () => {
    expect(reviewTicket(form({ price: "R$ 40,50" }), ctx())).toMatchObject({ ok: true, order: { limitPrice: 4050 } });
    expect(reviewTicket(form({ price: "40.5" }), ctx())).toMatchObject({ ok: true, order: { limitPrice: 4050 } });
  });
});

describe("mensagens e chave de envio", () => {
  it("todo código do contrato tem uma mensagem em português para a tela", () => {
    for (const code of ORDER_REJECT_CODES) expect(marketErrorMessage(code).length).toBeGreaterThan(10);
    expect(marketErrorMessage("order_not_found")).toBe(MARKET_ERROR_MESSAGES.order_not_found);
  });

  it("código desconhecido cai numa mensagem genérica", () => {
    expect(marketErrorMessage("alguma_coisa_nova")).toMatch(/tente de novo/i);
  });

  it("cada envio ganha uma Idempotency-Key própria e legível pelo servidor", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
});
