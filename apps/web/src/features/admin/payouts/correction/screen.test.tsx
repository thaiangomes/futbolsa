// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CorrectionChange, CorrectionPreview } from "@futbolsa/contracts";
import { ApiError } from "../../../../lib/api";
import type { AdminApi } from "../../api";
import { CorrectionScreen } from "./screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const render = async (element: ReactElement) => act(async () => root.render(element));
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const click = async (el: Element) => act(async () => (el as HTMLElement).click());
async function type(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const change = (over: Partial<CorrectionChange> = {}): CorrectionChange => ({
  key: "points|brasileirao-a|10|CAM3",
  kind: "points",
  club: { id: 1, ticker: "CAM3", name: "Atlético" },
  competition: "brasileirao-a",
  round: 10,
  phase: null,
  reason: "3 pontos, rodada 10",
  before: 30,
  after: 10,
  delta: -20,
  closedAtBefore: "2027-04-20T03:00:00.000Z",
  closedAtAfter: "2027-04-20T03:00:00.000Z",
  shares: 1000,
  total: -20_000,
  outcome: "correction",
  ...over,
});
const preview = (over: Partial<CorrectionPreview> = {}): CorrectionPreview => ({
  planCode: "plano-a",
  changes: [change()],
  wallets: { receive: 0, pay: 4, negative: 1, buysCancelled: 2 },
  months: ["2027-04"],
  ...over,
});
const applied = { planCode: "plano-a", events: [{ eventId: 7, key: "k", ticker: "CAM3", version: 2, supersedesId: 3, perShare: 10 }], wallets: preview().wallets };
const fake = (overrides: Partial<Record<keyof AdminApi, unknown>>) => ({ correctionPreview: async () => preview(), ...overrides }) as unknown as AdminApi;

describe("tela da correção (prancha 7b)", () => {
  it("mostra a diferença por evento, o resumo por carteira, o aviso de caixa negativo e os meses afetados", async () => {
    await render(createElement(CorrectionScreen, { admin: fake({}) }));
    expect(text()).toContain("Carteiras que devolvem");
    expect(text()).toContain("Compras abertas canceladas");
    expect(text()).toContain("Quem não tem caixa para devolver fica com o caixa negativo");
    expect(text()).toContain("−R$ 0,20");
    expect(text()).toContain("2027-04");
  });

  it("sem diferença não oferece aplicar", async () => {
    await render(createElement(CorrectionScreen, { admin: fake({ correctionPreview: async () => preview({ changes: [], months: [] }) }) }));
    expect(text()).toContain("Nada a corrigir");
    expect(button("Aplicar correção")).toBeUndefined();
  });

  it("o erro da prévia (por exemplo, pagamento ainda liquidando) aparece no lugar dela", async () => {
    const failing = async () => {
      throw new ApiError(409, "payout_settling", "Um pagamento aprovado ainda está sendo creditado: espere terminar.");
    };
    await render(createElement(CorrectionScreen, { admin: fake({ correctionPreview: failing }) }));
    expect(text()).toContain("ainda está sendo creditado");
  });

  it("aplicar exige o motivo e a confirmação, e manda o código da prévia", async () => {
    const apply = vi.fn(async () => applied);
    await render(createElement(CorrectionScreen, { admin: fake({ applyCorrection: apply }) }));
    expect(button("Aplicar correção").disabled).toBe(true);
    await type("#motivo", "súmula corrigida pela CBF");
    await click(button("Aplicar correção"));
    expect(apply).not.toHaveBeenCalled();
    await click(button("Confirmar"));
    expect(apply).toHaveBeenCalledWith({ planCode: "plano-a", reason: "súmula corrigida pela CBF" });
    expect(text()).toContain("Correção aplicada.");
    expect(text()).toContain("Pagamentos");
  });

  it("prévia desatualizada: não aplica, mostra a prévia nova com a linha nova marcada e pede para aplicar de novo", async () => {
    const next = preview({ planCode: "plano-b", changes: [change(), change({ key: "points|brasileirao-a|10|FLA3", club: { id: 2, ticker: "FLA3", name: "Flamengo" } })] });
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "correction_stale", "Os resultados mudaram desde a prévia da correção.", undefined, { preview: next }))
      .mockResolvedValueOnce({ ...applied, planCode: "plano-b" });
    await render(createElement(CorrectionScreen, { admin: fake({ applyCorrection: apply }) }));
    await type("#motivo", "placar errado");
    await click(button("Aplicar correção"));
    await click(button("Confirmar"));
    expect(text()).toContain("Prévia desatualizada.");
    expect(container.querySelectorAll("tr[data-fresh='sim']")).toHaveLength(1);
    expect(text()).toContain("FLA3");
    expect(text()).not.toContain("Correção aplicada.");

    await click(button("Aplicar correção"));
    await click(button("Confirmar"));
    expect(apply).toHaveBeenLastCalledWith({ planCode: "plano-b", reason: "placar errado" });
    expect(text()).toContain("Correção aplicada.");
  });

  it("prévia desatualizada sem a prévia nova recarrega a prévia e avisa", async () => {
    let calls = 0;
    const correctionPreview = vi.fn(async () => preview({ planCode: calls++ === 0 ? "plano-a" : "plano-c" }));
    const apply = vi.fn().mockRejectedValue(new ApiError(409, "correction_stale", "Os resultados mudaram."));
    await render(createElement(CorrectionScreen, { admin: fake({ correctionPreview, applyCorrection: apply }) }));
    await type("#motivo", "placar errado");
    await click(button("Aplicar correção"));
    await click(button("Confirmar"));
    expect(correctionPreview).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Prévia desatualizada.");
  });
});
