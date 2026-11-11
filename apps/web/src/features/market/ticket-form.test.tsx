// @vitest-environment jsdom
import { MARKET_ERROR_MESSAGES, type MyOrder, type PlaceOrderResponse } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { useDom } from "../../test-support/dom";
import type { MarketApi } from "./api";
import type { ClubState } from "./club-state";
import { OrderTicket } from "./ticket-form";

// W3 e W7 do Plano do livro de ofertas e formador: a boleta com revisão, os avisos de jogo e de leilão e a recusa da API.

const state = (over: Partial<ClubState> = {}): ClubState => ({
  ticker: "FLA3",
  seq: 1,
  price: { displayed: 4000, open: 4000, changeBp: 0 },
  matchMode: false,
  auction: null,
  market: { state: "open", opensAt: "2027-04-05T13:00:00.000Z", reason: null },
  bids: [],
  asks: [],
  trades: [],
  me: { band: { min: 3200, max: 4800 }, freeCash: 1_000_000, freeShares: 1200 },
  ...over,
});

const placed = (over: Partial<PlaceOrderResponse> = {}): PlaceOrderResponse => ({
  order: {
    id: 5,
    ticker: "FLA3",
    side: "buy",
    type: "limit",
    quantity: 100,
    filled: 0,
    limitPrice: 4000,
    reservedCash: 400_000,
    status: "open",
    cancelReason: null,
    createdAt: "2027-04-05T19:00:00.000Z",
    updatedAt: "2027-04-05T19:00:00.000Z",
  },
  trades: [],
  openedAuction: false,
  auction: null,
  cash: { total: 1_000_000, reserved: 400_000, free: 600_000 },
  ...over,
});

const fakeApi = (placeOrder: MarketApi["placeOrder"] = vi.fn(async () => placed())): MarketApi => ({ placeOrder }) as unknown as MarketApi;

describe("boleta", () => {
  const dom = useDom();

  const show = async (s: ClubState, api = fakeApi(), myOrders: MyOrder[] = []) => {
    await dom.render(createElement(OrderTicket, { state: s, myOrders, api }));
  };
  const fill = async (quantity: string, price?: string) => {
    await dom.type('input[aria-label="Quantidade"]', quantity);
    if (price !== undefined) await dom.type('input[aria-label="Preço"]', price);
  };

  it("visitante vê o convite para entrar, sem formulário", async () => {
    await show(state({ me: null }));
    expect(dom.text()).toContain("Entre na sua conta");
    expect(dom.$("[data-testid=boleta]")).toBeNull();
  });

  it("livro 6: mostra a faixa de R$ 32,00 a R$ 48,00 e o caixa livre (compra) ou as ações livres (venda)", async () => {
    await show(state());
    expect(dom.$("[data-testid=faixa]").textContent).toBe("R$ 32,00 a R$ 48,00");
    expect(dom.$("[data-testid=livre]").textContent).toBe("R$ 10.000,00");
    await dom.click(dom.button("Vender"));
    expect(dom.$("[data-testid=livre]").textContent).toBe("1.200 FLA3");
  });

  it("livro 6: a R$ 48,01 a boleta recusa no navegador com a mensagem do contrato, e o botão fica travado", async () => {
    await show(state());
    await fill("10", "48,01");
    expect(dom.$("[data-testid=erro-boleta]").textContent).toBe(MARKET_ERROR_MESSAGES.price_out_of_band);
    expect(dom.button("Revisar compra").disabled).toBe(true);
    await fill("10", "48,00");
    expect(dom.$("[data-testid=erro-boleta]")).toBeNull();
    expect(dom.button("Revisar compra").disabled).toBe(false);
  });

  it("livro 1: compra de 100 a R$ 40,00 reserva R$ 4.000,00; revisa, confirma e manda com uma Idempotency-Key", async () => {
    const placeOrder = vi.fn(async () => placed());
    const onSent = vi.fn();
    await dom.render(createElement(OrderTicket, { state: state(), myOrders: [], api: fakeApi(placeOrder), onSent }));
    await fill("100", "40,00");
    expect(dom.$("[data-testid=resumo]").textContent).toContain("R$ 4.000,00");
    await dom.click(dom.button("Revisar compra"));
    expect(dom.$("[data-testid=revisao]").textContent).toContain("Comprar 100 FLA3 a R$ 40,00");
    expect(dom.$("[data-testid=revisao-jogo]")).toBeNull();
    await dom.click(dom.button("Confirmar e enviar"));
    await dom.settle();
    expect(placeOrder).toHaveBeenCalledTimes(1);
    const [body, key] = placeOrder.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(body).toEqual({ ticker: "FLA3", side: "buy", type: "limit", quantity: 100, limitPrice: 4000 });
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(onSent).toHaveBeenCalled();
    expect(dom.$("[data-testid=enviada]").textContent).toContain("Ordem enviada");
  });

  it("livro 27: com o clube em jogo, a revisão avisa \"em jogo agora\"", async () => {
    await show(state({ matchMode: true }));
    await fill("10", "40,00");
    await dom.click(dom.button("Revisar compra"));
    expect(dom.$("[data-testid=revisao-jogo]").textContent).toContain("Em jogo agora");
  });

  it("livro 41 e W7: em leilão a boleta tira a ordem a mercado, avisa o fim do leilão e a revisão diz que nada executa agora", async () => {
    await show(state({ auction: { until: "2027-04-05T18:40:00.000Z" } }));
    expect(dom.button("A mercado")).toBeUndefined();
    expect(dom.$("[data-testid=boleta-leilao]").textContent).toContain("Em leilão até 15h40");
    await fill("10", "40,00");
    await dom.click(dom.button("Revisar compra"));
    expect(dom.$("[data-testid=revisao-leilao]").textContent).toContain("15h40");
  });

  it("a resposta que abriu um leilão diz até quando e que a ordem entrou inteira nele", async () => {
    const placeOrder = vi.fn(async () => placed({ openedAuction: true, auction: { until: "2027-04-05T18:40:00.000Z" } }));
    await show(state(), fakeApi(placeOrder));
    await fill("100", "45,00");
    await dom.click(dom.button("Revisar compra"));
    await dom.click(dom.button("Confirmar e enviar"));
    await dom.settle();
    expect(dom.$("[data-testid=enviada]").textContent).toContain("abriu um leilão até 15h40");
  });

  it("recusa da API aparece com a mensagem do código; a do clube suspenso traz o motivo", async () => {
    const refuse = (code: string, message: string) => vi.fn(async () => Promise.reject(new ApiError(422, code, message)));
    await show(state(), fakeApi(refuse("insufficient_cash", "texto da API")));
    await fill("10", "40,00");
    await dom.click(dom.button("Revisar compra"));
    await dom.click(dom.button("Confirmar e enviar"));
    await dom.settle();
    expect(dom.$("[data-testid=erro-boleta]").textContent).toBe(MARKET_ERROR_MESSAGES.insufficient_cash);

    await show(state(), fakeApi(refuse("club_suspended", "A negociação de FLA3 está suspensa: Placar errado")));
    await fill("10", "40,00");
    await dom.click(dom.button("Revisar compra"));
    await dom.click(dom.button("Confirmar e enviar"));
    await dom.settle();
    expect(dom.$("[data-testid=erro-boleta]").textContent).toContain("Placar errado");
  });

  it("falha de rede mantém a chave: a nova tentativa reusa a mesma Idempotency-Key e não duplica", async () => {
    const placeOrder = vi.fn().mockRejectedValueOnce(new TypeError("rede caiu")).mockResolvedValueOnce(placed());
    await show(state(), fakeApi(placeOrder));
    await fill("10", "40,00");
    await dom.click(dom.button("Revisar compra"));
    await dom.click(dom.button("Confirmar e enviar"));
    await dom.settle();
    expect(dom.$("[data-testid=erro-boleta]")).not.toBeNull();
    await dom.click(dom.button("Revisar compra"));
    await dom.click(dom.button("Confirmar e enviar"));
    await dom.settle();
    expect(placeOrder).toHaveBeenCalledTimes(2);
    expect(placeOrder.mock.calls[0]![1]).toBe(placeOrder.mock.calls[1]![1]);
  });

  it("livro 13: com uma venda minha a R$ 42,00 aberta, comprar a R$ 42,00 é recusado na boleta", async () => {
    const mine = { id: 1, ticker: "FLA3", side: "sell", type: "limit", quantity: 5, filled: 0, limitPrice: 4200, reservedCash: 0, status: "open", cancelReason: null, createdAt: "2027-04-05T19:00:00.000Z", updatedAt: "2027-04-05T19:00:00.000Z" } as MyOrder;
    await show(state(), fakeApi(), [mine]);
    await fill("1", "42,00");
    expect(dom.$("[data-testid=erro-boleta]").textContent).toBe(MARKET_ERROR_MESSAGES.self_trade);
    expect(dom.$("[data-testid=ordens-abertas]").textContent).toBe("1 de 50 ordens abertas");
  });

  it("antes da abertura o botão fica travado", async () => {
    await show(state({ market: { state: "not_open", opensAt: "2027-04-05T13:00:00.000Z", reason: null } }));
    await fill("10", "40,00");
    expect(dom.button("Revisar compra").disabled).toBe(true);
  });
});
