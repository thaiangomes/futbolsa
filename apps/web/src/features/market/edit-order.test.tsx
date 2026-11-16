// @vitest-environment jsdom
import type { BookView, MyOrder } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { useDom } from "../../test-support/dom";
import type { MarketApi } from "./api";
import { MyOrders } from "./my-orders";

// Livro de ofertas e formador de mercado, critério 60 (e a tela de edição dos 57 a 59): minhas ordens de todos os clubes
// com Editar e Cancelar, e o painel de edição com o livro ao vivo.

const level = (price: number, quantity: number, orders = 1) => ({ price, quantity, orders });
const view = (ticker: string): BookView => ({
  ticker,
  seq: 0,
  price: { displayed: 4300, open: 4000, changeBp: 750 },
  matchMode: false,
  auction: null,
  market: { state: "open", opensAt: "2027-04-05T13:00:00.000Z", reason: null },
  bids: [level(4200, 90, 2)],
  asks: [level(4410, 10)],
  trades: [],
  me: { band: { min: 3440, max: 5160 }, freeCash: 1_000_000, freeShares: 100 },
});
const order = (over: Partial<MyOrder> = {}): MyOrder => ({
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
  ...over,
});
const sale = order({ id: 8, ticker: "PAL3", side: "sell", quantity: 40, filled: 10, limitPrice: 4500, reservedCash: 0 });

const apiOf = (): MarketApi =>
  ({
    book: vi.fn(async (t: string) => view(t)),
    openOrders: vi.fn(async () => ({ orders: [] })),
    cancelOrder: vi.fn(),
    replaceOrder: vi.fn(async () => ({})),
  }) as unknown as MarketApi;

describe("minhas ordens com Editar (critério 60)", () => {
  const dom = useDom();
  const open = async (api: MarketApi, onChanged = vi.fn()) => {
    await dom.render(createElement(MyOrders, { orders: [order(), sale], onCancel: vi.fn(), api, onChanged }));
    await dom.settle();
    return onChanged;
  };
  const edit = async (index: number) => {
    await dom.click(dom.$$("[data-testid=editar]")[index]!);
    await dom.settle();
    await dom.settle();
  };

  it("livro 60: lista as ordens de todos os clubes, com o clube (link), Editar e Cancelar em cada uma", async () => {
    await open(apiOf());
    const rows = dom.$$("[data-testid=ordem]");
    expect(rows).toHaveLength(2);
    const links = dom.$$("[data-testid=ordem-clube]");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/clube?t=FLA3", "/clube?t=PAL3"]);
    expect(links.map((a) => a.textContent)).toEqual([expect.stringContaining("FLA3"), expect.stringContaining("PAL3")]);
    expect(dom.$$("[data-testid=editar]")).toHaveLength(2);
    expect(rows.every((r) => r.textContent!.includes("Cancelar"))).toBe(true);
  });

  it("livro 60: Editar mostra o livro do clube, a faixa, o livre com a ordem antiga devolvida, a reserva e o aviso da fila", async () => {
    const api = apiOf();
    await open(api);
    await edit(0);
    expect(api.book).toHaveBeenCalledWith("FLA3");
    expect(dom.$$("[data-testid=nivel-venda]")).toHaveLength(1);
    expect(dom.$$("[data-testid=nivel-compra]")).toHaveLength(1);
    expect(dom.$("[data-testid=faixa-edicao]").textContent).toBe("R$ 34,40 a R$ 51,60");
    // R$ 10.000,00 livres mais os R$ 4.200,00 que a ordem antiga prende
    expect(dom.$("[data-testid=livre-edicao]").textContent).toBe("R$ 14.200,00");
    expect(dom.$("[data-testid=reserva-nova]").textContent).toBe("R$ 4.200,00");
    expect(dom.$("[data-testid=aviso-fila]").textContent).toContain("fim da fila");
    expect((dom.$('[aria-label="Quantidade"]') as HTMLInputElement).value).toBe("100");
    expect((dom.$('[aria-label="Preço"]') as HTMLInputElement).value).toBe("42,00");
  });

  it("livro 60: tocar numa oferta do livro preenche o preço, e Salvar manda a troca com preço e quantidade e relê as ordens", async () => {
    const api = apiOf();
    const onChanged = await open(api);
    await edit(0);
    expect((dom.$("[data-testid=salvar-edicao]") as HTMLButtonElement).disabled).toBe(true); // nada mudou
    await dom.click(dom.$("[data-testid=nivel-venda]"));
    expect((dom.$('[aria-label="Preço"]') as HTMLInputElement).value).toBe("44,10");
    expect(dom.$("[data-testid=reserva-nova]").textContent).toBe("R$ 4.410,00");
    await dom.type('[aria-label="Quantidade"]', "120");
    expect(dom.$("[data-testid=reserva-nova]").textContent).toBe("R$ 5.292,00");
    await dom.click(dom.$("[data-testid=salvar-edicao]"));
    await dom.settle();
    expect(api.replaceOrder).toHaveBeenCalledWith(7, { quantity: 120, limitPrice: 4410 }, expect.any(String));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(dom.$("[data-testid=editar-ordem]")).toBeNull();
  });

  it("livro 60 e 58: a recusa da API aparece com o motivo, o painel continua aberto e nada é relido", async () => {
    const api = apiOf();
    (api.replaceOrder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(422, "insufficient_cash", "sem caixa"));
    const onChanged = await open(api);
    await edit(0);
    await dom.type('[aria-label="Quantidade"]', "110");
    await dom.click(dom.$("[data-testid=salvar-edicao]"));
    await dom.settle();
    expect(dom.$("[data-testid=erro-edicao]").textContent).toBe("Seu caixa livre não cobre esta compra.");
    expect(dom.$("[data-testid=editar-ordem]")).not.toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("livro 60: a conferência no navegador usa o caixa com a ordem antiga devolvida (a troca cabe mesmo sem caixa livre para uma ordem nova)", async () => {
    const api = apiOf();
    await open(api);
    await edit(0);
    // R$ 14.200,00 cabem; R$ 14.300,00 não
    await dom.type('[aria-label="Quantidade"]', "338"); // 338 × R$ 42,00 = R$ 14.196,00
    expect(dom.$("[data-testid=erro-edicao]")).toBeNull();
    await dom.type('[aria-label="Quantidade"]', "340"); // R$ 14.280,00
    expect(dom.$("[data-testid=erro-edicao]").textContent).toBe("Seu caixa livre não cobre esta compra.");
  });

  it("livro 59 e 60: na venda parcialmente executada a quantidade vem com o que falta e o livre soma as ações que ela prende", async () => {
    await open(apiOf());
    await edit(1);
    expect((dom.$('[aria-label="Quantidade"]') as HTMLInputElement).value).toBe("30"); // 40 pedidas − 10 executadas
    expect(dom.$("[data-testid=livre-edicao]").textContent).toBe("130 PAL3"); // 100 livres + 30 presas
    expect(dom.$("[data-testid=editar-ordem]").textContent).toContain("10 já executadas ficam como estão");
  });

  it("livro 60: no celular a edição abre como folha por cima da tela", async () => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    try {
      await open(apiOf());
      await edit(0);
      expect(dom.$("[data-testid=folha-edicao]")).not.toBeNull();
      expect(dom.$("[data-testid=folha-edicao] [data-testid=editar-ordem]")).not.toBeNull();
    } finally {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  });

  it("livro 60: sem a API (visitante ou tela sem edição), a lista não mostra Editar", async () => {
    await dom.render(createElement(MyOrders, { orders: [order()], onCancel: vi.fn() }));
    expect(dom.$$("[data-testid=editar]")).toHaveLength(0);
  });
});
