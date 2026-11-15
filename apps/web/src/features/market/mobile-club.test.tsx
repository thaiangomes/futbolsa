// @vitest-environment jsdom
import type { BookView, MyOrder } from "@futbolsa/contracts";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import type { MarketApi } from "./api";
import { ClubView } from "./club-screen";

// W5 do Plano do livro de ofertas e formador: o celular (390 px) com abas e a boleta como folha.

const level = (price: number, quantity: number, orders = 1) => ({ price, quantity, orders });
const view = (over: Partial<BookView> = {}): BookView => ({
  ticker: "FLA3",
  seq: 0,
  price: { displayed: 4430, open: 4300, changeBp: 302 },
  matchMode: true,
  auction: null,
  market: { state: "open", opensAt: "2027-04-05T13:00:00.000Z", reason: null },
  bids: [level(4420, 90, 2)],
  asks: [level(4460, 120, 3)],
  trades: [{ id: 2, at: "2027-04-05T19:14:00.000Z", price: 4430, quantity: 50 }],
  me: { band: { min: 3544, max: 5316 }, freeCash: 1_689_000, freeShares: 1200 },
  ...over,
});
const mineOrder: MyOrder = {
  id: 7, ticker: "FLA3", side: "buy", type: "limit", quantity: 100, filled: 0, limitPrice: 4420, reservedCash: 442_000,
  status: "open", cancelReason: null, createdAt: "2027-04-05T19:00:00.000Z", updatedAt: "2027-04-05T19:00:00.000Z",
};
const api = (v: BookView): MarketApi => ({ book: vi.fn(async () => v), openOrders: vi.fn(async () => ({ orders: [mineOrder] })), cancelOrder: vi.fn(), placeOrder: vi.fn() }) as unknown as MarketApi;

/** Faz a janela parecer um celular (matchMedia diz que a consulta de tela estreita vale). */
function phone() {
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("max-width"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

describe("tela do clube no celular", () => {
  const dom = useDom();
  afterEach(() => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });

  const open = async (logged = true) => {
    phone();
    await dom.render(createElement(ClubView, { ticker: "FLA3", api: api(view()), logged }));
    await dom.settle();
    await dom.settle();
  };

  it("mostra o preço, o aviso de jogo e as abas; começa no livro", async () => {
    await open();
    expect(dom.$("[data-testid=clube-celular]")).not.toBeNull();
    expect(dom.$("[data-testid=preco]").textContent).toBe("R$ 44,30");
    expect(dom.$("[data-testid=aviso-jogo]")).not.toBeNull();
    expect(dom.$$("[data-testid=nivel-compra]")).toHaveLength(1);
    expect(dom.$("[data-testid=negocio]")).toBeNull();
  });

  it("as abas trocam entre livro, negócios e minhas ordens", async () => {
    await open();
    await dom.click(dom.button("Negócios"));
    expect(dom.$$("[data-testid=negocio]")).toHaveLength(1);
    expect(dom.$("[data-testid=nivel-compra]")).toBeNull();
    await dom.click(dom.button("Minhas ordens"));
    expect(dom.$$("[data-testid=ordem]")).toHaveLength(1);
  });

  it("Comprar abre a boleta como folha no lado da compra, Vender no da venda, e o × fecha", async () => {
    await open();
    expect(dom.$("[data-testid=folha-boleta]")).toBeNull();
    await dom.click(dom.button("Comprar"));
    expect(dom.$("[data-testid=folha-boleta]")).not.toBeNull();
    expect(dom.$("[data-testid=livre]").textContent).toBe("R$ 16.890,00");
    await dom.click(dom.$('[aria-label="Fechar"]'));
    expect(dom.$("[data-testid=folha-boleta]")).toBeNull();
    await dom.click(dom.button("Vender"));
    expect(dom.$("[data-testid=livre]").textContent).toBe("1.200 FLA3");
  });

  it("o visitante vê as abas do livro e dos negócios, sem Minhas ordens", async () => {
    await open(false);
    expect(dom.button("Minhas ordens")).toBeUndefined();
    expect(dom.button("Livro")).toBeDefined();
  });
  it("livro 38: a aba Sobre leva ao cartão Quanto vale para você, com o preço do clube, para logado e visitante", async () => {
    phone();
    const dividends = vi.fn(async () => ({
      ticker: "FLA3", league: "brasileirao-a" as const, leagueRules: { perPoint: 10, placement: [500, 450, 400] }, leagueOpen: true,
      points: 20, position: 5, paid: 270, toReceive: 30, buybackMultipleBp: 15_000, cups: [],
    }));
    await dom.render(createElement(ClubView, { ticker: "FLA3", api: { ...api(view()), dividends } as unknown as MarketApi, logged: false }));
    await dom.settle();
    await dom.settle();
    await dom.click(dom.button("Sobre"));
    await dom.settle();
    await dom.settle();
    expect(dividends).toHaveBeenCalledWith("FLA3");
    expect(dom.$("[data-testid=valor-recompra-hoje]").textContent).toContain("R$ 4,50");
    expect(dom.$("[data-testid=sim-comparacao]").textContent).toContain("R$ 44,30");
    expect(dom.$("[data-testid=nivel-compra]")).toBeNull();
  });
});
