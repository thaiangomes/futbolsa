// @vitest-environment jsdom
import type { EventEnvelope, MyOrder } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import { applyOrderEvent } from "./my-orders-state";
import { MyOrders } from "./my-orders";

// W1 e W4 do Plano do livro de ofertas e formador: minhas ordens abertas, pelo GET /orders e pelo order.updated.

const order = (over: Partial<MyOrder> = {}): MyOrder => ({
  id: 12,
  ticker: "FLA3",
  side: "buy",
  type: "limit",
  quantity: 100,
  filled: 0,
  limitPrice: 4450,
  reservedCash: 445_000,
  status: "open",
  cancelReason: null,
  createdAt: "2027-04-05T19:22:00.000Z",
  updatedAt: "2027-04-05T19:22:00.000Z",
  ...over,
});
const update = (data: unknown): EventEnvelope => ({ type: "order.updated", channel: "me", seq: 1, at: "2027-04-05T19:30:00.000Z", data }) as EventEnvelope;
const updated = (over: Record<string, unknown> = {}) => ({
  id: 12,
  ticker: "FLA3",
  side: "buy",
  type: "limit",
  quantity: 100,
  filled: 60,
  limitPrice: 4450,
  reservedCash: 178_000,
  status: "open",
  cancelReason: null,
  ...over,
});

describe("applyOrderEvent", () => {
  it("execução parcial atualiza o executado e a reserva; a ordem continua na lista", () => {
    const next = applyOrderEvent([order()], update(updated()));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 12, filled: 60, reservedCash: 178_000, createdAt: "2027-04-05T19:22:00.000Z" });
  });

  it("ordem executada por inteiro ou cancelada sai da lista", () => {
    expect(applyOrderEvent([order()], update(updated({ filled: 100, status: "filled", reservedCash: 0 })))).toEqual([]);
    expect(applyOrderEvent([order()], update(updated({ status: "cancelled", cancelReason: "player", reservedCash: 0 })))).toEqual([]);
  });

  it("ordem nova que o cliente ainda não conhece entra, em ordem de id; aplicar duas vezes dá o mesmo", () => {
    const once = applyOrderEvent([order({ id: 20 })], update(updated({ id: 12, filled: 0, reservedCash: 445_000 })));
    expect(once.map((o) => o.id)).toEqual([12, 20]);
    expect(applyOrderEvent(once, update(updated({ id: 12, filled: 0, reservedCash: 445_000 })))).toEqual(once);
  });

  it("outro evento, ou dado fora do esquema (com campo a mais), não muda a lista", () => {
    const list = [order()];
    expect(applyOrderEvent(list, { ...update({}), type: "wallet.changed" } as EventEnvelope)).toBe(list);
    expect(applyOrderEvent(list, update({ ...updated(), walletId: 4 }))).toBe(list);
  });
});

describe("minhas ordens (tela)", () => {
  const dom = useDom();

  it("livro 16: lista as ordens do clube com o que falta, a reserva e o botão de cancelar", async () => {
    const onCancel = vi.fn();
    await dom.render(createElement(MyOrders, { orders: [order(), order({ id: 13, ticker: "PAL3" })], ticker: "FLA3", onCancel }));
    const rows = dom.$$("[data-testid=ordem]");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Compra");
    expect(rows[0]!.textContent).toContain("100 a R$ 44,50");
    expect(rows[0]!.textContent).toContain("R$ 4.450,00 reservados");
    expect(dom.$("[data-testid=contagem-ordens]").textContent).toBe("2 de 50 ordens abertas");
    await dom.click(dom.button("Cancelar"));
    expect(onCancel).toHaveBeenCalledWith(12);
  });

  it("sem ordens, diz que não há; venda não mostra reserva de caixa", async () => {
    await dom.render(createElement(MyOrders, { orders: [], ticker: "FLA3", onCancel: () => undefined }));
    expect(dom.$("[data-testid=sem-ordens]").textContent).toContain("FLA3");
    await dom.render(createElement(MyOrders, { orders: [order({ side: "sell", reservedCash: 0 })], onCancel: () => undefined }));
    expect(dom.text()).toContain("Venda");
    expect(dom.text()).not.toContain("reservados");
  });

  it("admin 24: o botão de cancelar continua disponível (a tela não depende do estado do mercado) e fica travado enquanto cancela", async () => {
    await dom.render(createElement(MyOrders, { orders: [order()], onCancel: () => undefined, busyId: 12 }));
    expect(dom.button("Cancelar").disabled).toBe(true);
  });
});
