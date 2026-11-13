// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FraudCaseDetail } from "@futbolsa/contracts";
import type { AdminApi } from "./api";
import { fraudAccountOf } from "./audit-screen";
import { defaultSelection, formatBp, FraudCaseScreen, FraudCasesScreen } from "./fraud-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// F14, T29: as telas da trapaça (Admin 39, 41, 42, 44 e 45, na tela).

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const render = (element: ReactElement) => act(async () => root.render(element));
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement;
const click = (el: Element) => act(async () => (el as HTMLElement).click());
async function type(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const fake = (overrides: Partial<Record<keyof AdminApi, unknown>>) => overrides as unknown as AdminApi;

const ANA = "11111111-1111-4111-8111-111111111111";
const BRUNO = "22222222-2222-4222-8222-222222222222";
const trade = (id: number, price: number, before: number, over = {}) => ({
  id, at: `2027-07-0${id}T15:00:00.000Z`, ticker: "SPT3", quantity: 1, price, priceBefore: before, variationBp: 1000, inAuction: false,
  buyerWalletId: 1, sellerWalletId: 2, suspicious: true, selected: false, annulled: false, ...over,
});
const detail = (over: Partial<FraudCaseDetail> = {}): FraudCaseDetail => ({
  id: 7, origin: "alert", status: "open", ticker: "SPT3", periodFrom: "2027-07-01T15:00:00.000Z", periodTo: "2027-07-03T15:00:00.000Z", openedAt: "2027-07-03T15:01:00.000Z",
  openedBy: null, decidedAt: null, decidedBy: null, decisionReason: null, reportHash: null,
  parties: [
    { walletId: 1, kind: "player", userId: ANA, label: "Ana", email: "ana@exemplo.com", warnings: 0 },
    { walletId: 2, kind: "player", userId: BRUNO, label: "Bruno", email: "bruno@exemplo.com", warnings: 1 },
  ],
  report: {
    trades: [trade(1, 770, 700), trade(2, 847, 770), trade(3, 931, 847, { annulled: true })],
    clubs: [{ ticker: "SPT3", clubTrades: 3, pairTrades: 3, priceFrom: 700, priceTo: 931, priceToWithoutPair: 700 }],
    series: [
      { at: "2027-07-01T23:59:59.000Z", ticker: "SPT3", price: 770, priceWithout: 700, fairValue: 720 },
      { at: "2027-07-02T23:59:59.000Z", ticker: "SPT3", price: 931, priceWithout: 700, fairValue: 720 },
    ],
    months: [{ month: "2027-07", at: "2027-07-03T15:00:00.000Z", open: true, accounts: [{ walletId: 1, equity: 10_100_000, equityWithout: 10_000_000, rank: 1, rankWithout: 4 }] }],
    others: [],
  },
  ...over,
} as FraudCaseDetail);

describe("trapaça: ajudantes", () => {
  it("a marcação de saída é dos suspeitos ainda não anulados, e a variação sai com sinal", () => {
    expect(defaultSelection(detail().report)).toEqual([1, 2]);
    expect(formatBp(1000)).toBe("+10,00%");
    expect(formatBp(-523)).toBe("−5,23%");
  });
  it("a conta do filtro da auditoria vira o corpo do relatório; a casa e o vazio não", () => {
    expect(fraudAccountOf(ANA)).toEqual({ userId: ANA });
    expect(fraudAccountOf("bot:12")).toEqual({ botId: 12 });
    expect(fraudAccountOf("house")).toBeNull();
    expect(fraudAccountOf("")).toBeNull();
  });
});

describe("lista de casos", () => {
  it("admin 39: o alerta aparece com as contas e os suspeitos, e abre o relatório", async () => {
    const fraudCases = vi.fn(async () => ({
      cases: [{ id: 7, origin: "alert", status: "open", ticker: "SPT3", periodFrom: "", periodTo: "", openedAt: "2027-07-03T15:01:00.000Z", decidedAt: null, parties: detail().parties, tradeCount: 3, suspiciousCount: 3 }],
      nextCursor: null,
    }));
    await render(createElement(FraudCasesScreen, { admin: fake({ fraudCases }) }));
    expect(fraudCases).toHaveBeenCalledWith({ status: "open" });
    expect(text()).toContain("Ana");
    expect(text()).toContain("Bruno");
    expect(text()).toContain("3 de 3");
    expect(container.querySelector('a[href="/admin/trapaca?id=7"]')).not.toBeNull();
  });
});

describe("relatório e decisão", () => {
  const api = (over: Record<string, unknown> = {}) =>
    fake({
      fraudCase: vi.fn(async () => detail()),
      confirmFraud: vi.fn(async () => ({ caseId: 7, status: "confirmed", annulled: [{ tradeId: 1, sharesReturned: 1, sharesShort: 0, cashReturned: 770 }], banOffer: [{ userId: BRUNO, label: "Bruno", previousWarnings: 1 }] })),
      dismissFraud: vi.fn(async () => ({ caseId: 7, status: "dismissed" })),
      banFraud: vi.fn(async () => ({ userId: BRUNO, status: "blocked" })),
      ...over,
    });

  it("admin 41: mostra os negócios com variação, o peso no clube e o patrimônio com e sem", async () => {
    await render(createElement(FraudCaseScreen, { admin: api(), id: 7 }));
    expect(text()).toContain("+10,00%");
    expect(text()).toContain("3 de 3");
    expect(text()).toContain("R$ 9,31");
    expect(text()).toContain("já anulado");
    expect(text()).toContain("1 advertência");
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("admin 42: só os marcados são anulados; o botão pede o motivo e a chave é a mesma até dar certo", async () => {
    const confirmFraud = vi.fn(async () => ({ caseId: 7, status: "confirmed", annulled: [], banOffer: [] }));
    await render(createElement(FraudCaseScreen, { admin: api({ confirmFraud }), id: 7 }));
    expect(button("Confirmar e anular 2 negócios").disabled).toBe(true); // sem motivo
    await click(container.querySelector('input[aria-label="Anular o negócio 2"]')!); // desmarca o 2º
    await type("#motivo-trapaca", "preços combinados no SPT3");
    expect(button("Confirmar e anular 1 negócio").disabled).toBe(false);
    await click(button("Confirmar e anular 1 negócio"));
    expect(confirmFraud).toHaveBeenCalledWith(7, { tradeIds: [1], reason: "preços combinados no SPT3" }, expect.any(String));
    // o negócio já anulado por outro caso não dá para marcar
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Anular o negócio 3"]')).toBeNull();
  });

  it("admin 44: descartar pede motivo e não anula nada", async () => {
    const dismissFraud = vi.fn(async () => ({ caseId: 7, status: "dismissed" }));
    const confirmFraud = vi.fn();
    await render(createElement(FraudCaseScreen, { admin: api({ dismissFraud, confirmFraud }), id: 7 }));
    expect(button("Descartar o caso").disabled).toBe(true);
    await type("#motivo-trapaca", "pares normais, sem combinação");
    await click(button("Descartar o caso"));
    expect(dismissFraud).toHaveBeenCalledWith(7, { reason: "pares normais, sem combinação" });
    expect(confirmFraud).not.toHaveBeenCalled();
  });

  it("admin 45: depois de confirmar, a conta com advertência anterior recebe a oferta de banir, que pede motivo", async () => {
    const banFraud = vi.fn(async () => ({ userId: BRUNO, status: "blocked" }));
    await render(createElement(FraudCaseScreen, { admin: api({ banFraud }), id: 7 }));
    await type("#motivo-trapaca", "preços combinados no SPT3");
    await click(button("Confirmar e anular"));
    expect(text()).toContain("Reincidência");
    expect(button("Banir Bruno").disabled).toBe(true);
    await type(`#motivo-ban-${BRUNO}`, "trapaça repetida");
    await click(button("Banir Bruno"));
    expect(banFraud).toHaveBeenCalledWith(7, { userId: BRUNO, reason: "trapaça repetida" });
    expect(text()).toContain("foi banida");
  });

  it("o caso decidido não tem marcação nem botões de decidir, e mostra a foto e o hash", async () => {
    const decided = detail({ status: "confirmed", decidedAt: "2027-07-04T10:00:00.000Z", decisionReason: "combinaram", reportHash: "abc123" });
    await render(createElement(FraudCaseScreen, { admin: api({ fraudCase: vi.fn(async () => decided) }), id: 7 }));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(button("Descartar o caso")).toBeUndefined();
    expect(text()).toContain("abc123");
    expect(text()).toContain("combinaram");
  });
});
