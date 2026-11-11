// @vitest-environment jsdom
import type { BookView, MyOrder } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import type { MarketApi } from "./api";
import { ClubView } from "./club-screen";

// W1, W2, W4 e W5 do Plano do livro de ofertas e formador: a tela do clube de ponta a ponta, com o tempo real falso.

const level = (price: number, quantity: number, orders = 1) => ({ price, quantity, orders });
const view = (over: Partial<BookView> = {}): BookView => ({
  ticker: "FLA3",
  seq: 0,
  price: { displayed: 4300, open: 4000, changeBp: 750 },
  matchMode: false,
  auction: null,
  market: { state: "open", opensAt: "2027-04-05T13:00:00.000Z", reason: null },
  bids: [level(4200, 90, 2)],
  asks: [level(4410, 10)],
  trades: [{ id: 2, at: "2027-04-05T19:14:00.000Z", price: 4300, quantity: 50 }],
  me: { band: { min: 3440, max: 5160 }, freeCash: 1_000_000, freeShares: 100 },
  ...over,
});
const mineOrder: MyOrder = {
  id: 7,
  ticker: "FLA3",
  side: "buy",
  type: "limit",
  quantity: 100,
  filled: 0,
  limitPrice: 4200,
  reservedCash: 420_000,
  status: "open",
  cancelReason: null,
  createdAt: "2027-04-05T19:00:00.000Z",
  updatedAt: "2027-04-05T19:00:00.000Z",
};

const api = (v: BookView, orders: MyOrder[] = []): MarketApi =>
  ({
    book: vi.fn(async () => v),
    openOrders: vi.fn(async () => ({ orders })),
    cancelOrder: vi.fn(async () => ({})),
    placeOrder: vi.fn(),
  }) as unknown as MarketApi;

describe("tela do clube", () => {
  const dom = useDom();

  it("livro 35: assina o canal do clube e mostra preço, livro e negócios; um negócio e um livro novos mudam a tela sem recarregar", async () => {
    await dom.render(createElement(ClubView, { ticker: "FLA3", api: api(view({ me: null })), logged: false }));
    await dom.settle();
    expect(dom.realtime.subscribedChannels()).toContain("club:FLA3");
    expect(dom.$("[data-testid=preco]").textContent).toBe("R$ 43,00");
    expect(dom.$$("[data-testid=nivel-compra]")).toHaveLength(1);
    expect(dom.$$("[data-testid=negocio]")).toHaveLength(1);

    await dom.realtime.emit("club:FLA3", "trade", { id: 3, at: "2027-04-05T19:20:00.000Z", price: 4410, quantity: 10 }, 1);
    expect(dom.$("[data-testid=preco]").textContent).toBe("R$ 44,10");
    expect(dom.$("[data-testid=variacao]").textContent).toBe("▲ +10,25%");
    expect(dom.$$("[data-testid=negocio]")).toHaveLength(2);

    await dom.realtime.emit("club:FLA3", "book", { bids: [level(4400, 5), level(4200, 90, 2)], asks: [], auction: null }, 2);
    expect(dom.$$("[data-testid=nivel-compra]")).toHaveLength(2);
    expect(dom.$$("[data-testid=nivel-venda]")).toHaveLength(0);
  });

  it("visitante vê o livro e os negócios, mas nem a boleta nem as ordens, e não assina o canal da conta", async () => {
    await dom.render(createElement(ClubView, { ticker: "FLA3", api: api(view({ me: null })), logged: false }));
    await dom.settle();
    expect(dom.text()).toContain("Entre na sua conta");
    expect(dom.$("[data-testid=boleta]")).toBeNull();
    expect(dom.text()).not.toContain("Minhas ordens");
    expect(dom.realtime.subscribedChannels()).not.toContain("me");
  });

  it("livro 18: a minha ordem aparece destacada no livro e em Minhas ordens, e some quando executa", async () => {
    await dom.render(createElement(ClubView, { ticker: "FLA3", api: api(view(), [mineOrder]), logged: true }));
    await dom.settle();
    await dom.settle();
    expect(dom.realtime.subscribedChannels()).toContain("me");
    expect(dom.$("[data-testid=nivel-compra]").getAttribute("data-mine")).toBe("true");
    expect(dom.$$("[data-testid=ordem]")).toHaveLength(1);
    // executou por inteiro: sai da lista e o destaque some
    await dom.realtime.emit("me", "order.updated", {
      id: 7, ticker: "FLA3", side: "buy", type: "limit", quantity: 100, filled: 100, limitPrice: 4200, reservedCash: 0, status: "filled", cancelReason: null,
    });
    expect(dom.$$("[data-testid=ordem]")).toHaveLength(0);
    expect(dom.$("[data-testid=nivel-compra]").getAttribute("data-mine")).toBe("false");
  });

  it("livro 16: cancelar chama a API e relê as ordens", async () => {
    const a = api(view(), [mineOrder]);
    await dom.render(createElement(ClubView, { ticker: "FLA3", api: a, logged: true }));
    await dom.settle();
    await dom.settle();
    await dom.click(dom.button("Cancelar"));
    await dom.settle();
    expect(a.cancelOrder).toHaveBeenCalledWith(7);
    expect(a.openOrders).toHaveBeenCalledTimes(2);
  });

  it("a faixa da boleta anda com o preço exibido: depois de um negócio a R$ 44,10 vai de R$ 35,28 a R$ 52,92", async () => {
    await dom.render(createElement(ClubView, { ticker: "FLA3", api: api(view()), logged: true }));
    await dom.settle();
    await dom.settle();
    expect(dom.$("[data-testid=faixa]").textContent).toBe("R$ 34,40 a R$ 51,60");
    await dom.realtime.emit("club:FLA3", "trade", { id: 3, at: "2027-04-05T19:20:00.000Z", price: 4410, quantity: 10 }, 1);
    expect(dom.$("[data-testid=faixa]").textContent).toBe("R$ 35,28 a R$ 52,92");
  });

  it("leilão e jogo: os avisos aparecem pelo book e pelo match_mode, sem recarregar", async () => {
    await dom.render(createElement(ClubView, { ticker: "FLA3", api: api(view({ me: null })), logged: false }));
    await dom.settle();
    await dom.realtime.emit("club:FLA3", "match_mode", { active: true }, 1);
    expect(dom.$("[data-testid=chip-jogo]")).not.toBeNull();
    await dom.realtime.emit("club:FLA3", "book", { bids: [], asks: [], auction: { until: "2027-04-05T18:40:00.000Z" } }, 2);
    expect(dom.$("[data-testid=chip-leilao]").textContent).toContain("Em leilão até 15h40");
  });
});
