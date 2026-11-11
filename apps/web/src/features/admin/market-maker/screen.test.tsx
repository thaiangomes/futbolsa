// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApi } from "../api";
import { MarketMakerScreen } from "./screen";

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
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector(selector) as T;
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
async function type(selector: string, value: string) {
  const input = $<HTMLInputElement>(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = async (el: Element) => act(async () => (el as HTMLElement).click());

const values = { mmQuantityBp: 25, mmMatchQuantityBp: 6, mmMinSideQty: 10, mmMatchMinSideQty: 3, mmLotBp: 2000 };
const treasury = {
  cash: 41_230_000,
  freeCash: 41_230_000,
  clubs: [
    { ticker: "FLA3", totalShares: 3736, freeShares: 212, status: "trading", auctionUntil: null },
    { ticker: "PAL3", totalShares: 3000, freeShares: 0, status: "trading", auctionUntil: null },
    { ticker: "CAM3", totalShares: 3736, freeShares: 430, status: "suspended", auctionUntil: null },
  ],
};
const state = { ...values, treasury };
const seasonOf = (status: string) => ({ season: { id: 1, status }, clubs: [] });
const fake = (overrides: Partial<Record<keyof AdminApi, unknown>> = {}) =>
  ({ marketMaker: async () => state, currentSeason: async () => seasonOf("trading"), ...overrides }) as unknown as AdminApi;

describe("formador no admin (livro 34, prancha 7l)", () => {
  it("mostra os valores em vigor e o lote travado depois da abertura do IPO", async () => {
    await render(createElement(MarketMakerScreen, { admin: fake() }));
    expect($<HTMLInputElement>("#pf").value).toBe("0,25");
    expect($<HTMLInputElement>("#pj").value).toBe("0,06");
    expect($<HTMLInputElement>("#mf").value).toBe("10");
    expect($<HTMLInputElement>("#mj").value).toBe("3");
    expect(text()).toContain("20% da oferta");
    expect(text()).toContain("travado");
  });

  it("antes da abertura do IPO o lote não aparece como travado", async () => {
    await render(createElement(MarketMakerScreen, { admin: fake({ currentSeason: async () => seasonOf("preparing") }) }));
    expect(text()).not.toContain("travado");
  });

  it("Salvar só liga com mudança, valores válidos e motivo; manda só o que mudou, com o motivo", async () => {
    let current = state;
    const update = vi.fn(async () => {
      current = { ...state, mmQuantityBp: 30, mmMatchMinSideQty: 4 };
      return values;
    });
    await render(createElement(MarketMakerScreen, { admin: fake({ marketMaker: async () => current, updateMarketMaker: update }) }));
    expect(button("Salvar").disabled).toBe(true);
    await type("#pf", "0,30");
    await type("#mj", "4");
    expect(button("Salvar").disabled).toBe(true); // falta o motivo
    await type("#motivo", "casa com pouca liquidez");
    expect(button("Salvar").disabled).toBe(false);
    await click(button("Salvar"));
    expect(update).toHaveBeenCalledWith({ mmQuantityBp: 30, mmMatchMinSideQty: 4, reason: "casa com pouca liquidez" });
    expect(text()).toContain("Salvo");
    expect($<HTMLInputElement>("#motivo").value).toBe("");
    expect($<HTMLInputElement>("#pf").value).toBe("0,3");
    expect(button("Salvar").disabled).toBe(true);
  });

  it("valor inválido mostra o aviso e desliga o Salvar", async () => {
    await render(createElement(MarketMakerScreen, { admin: fake() }));
    await type("#pf", "0");
    await type("#motivo", "teste de motivo");
    expect(text()).toContain("maior que zero");
    expect(button("Salvar").disabled).toBe(true);
    await type("#pf", "0,25");
    await type("#mf", "0");
    expect(text()).toContain("inteiro de ações");
    expect(button("Salvar").disabled).toBe(true);
  });

  it("Desfazer volta aos valores em vigor", async () => {
    await render(createElement(MarketMakerScreen, { admin: fake() }));
    expect(button("Desfazer").disabled).toBe(true);
    await type("#pf", "1");
    expect(button("Desfazer").disabled).toBe(false);
    await click(button("Desfazer"));
    expect($<HTMLInputElement>("#pf").value).toBe("0,25");
    expect(button("Desfazer").disabled).toBe(true);
  });

  it("erro da API aparece e os valores digitados ficam", async () => {
    const update = vi.fn(async () => {
      throw new Error("Não há temporada em andamento.");
    });
    await render(createElement(MarketMakerScreen, { admin: fake({ updateMarketMaker: update }) }));
    await type("#pf", "0,30");
    await type("#motivo", "motivo qualquer");
    await click(button("Salvar"));
    expect(text()).toContain("Não há temporada em andamento.");
    expect($<HTMLInputElement>("#pf").value).toBe("0,30");
  });

  it("quadro da tesouraria: caixa, ações livres, situação e o que a casa cota em cada clube", async () => {
    await render(createElement(MarketMakerScreen, { admin: fake() }));
    expect(text()).toContain("Tesouraria agora");
    expect(text()).toContain("R$ 412.300,00");
    const rows = [...container.querySelectorAll("tbody tr")].map((r) => r.textContent ?? "");
    const pal = rows.find((r) => r.startsWith("PAL3"))!;
    expect(pal).toContain("Só compra: a tesouraria está sem ações livres do PAL3");
    expect(rows.find((r) => r.startsWith("FLA3"))).toContain("Compra e venda");
    expect(rows.find((r) => r.startsWith("CAM3"))).toContain("Suspenso");
    expect(rows.find((r) => r.startsWith("CAM3"))).toContain("Nada: a casa não cota clube suspenso");
  });

  it("prévia num clube: o depois acompanha o que o admin digita, e o clube da prévia pode mudar", async () => {
    await render(createElement(MarketMakerScreen, { admin: fake() }));
    expect($("#depois-fora").textContent).toBe("10 por lado (0,25% dá 9; vale o mínimo)");
    expect($("#depois-jogo").textContent).toBe("3 por lado (0,06% dá 2; vale o mínimo)");
    await type("#pf", "1");
    expect($("#depois-fora").textContent).toBe("37 por lado");
    await type("#pf", "x");
    expect($("#depois-fora").textContent).toBe("—");
    const select = $<HTMLSelectElement>("#previa-clube");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "PAL3");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(text()).toContain("com 3.000 ações");
  });

  it("sem tesouraria (antes da abertura do IPO) a tela mostra só os percentuais", async () => {
    await render(createElement(MarketMakerScreen, { admin: fake({ marketMaker: async () => ({ ...values, treasury: null }) }) }));
    expect(text()).not.toContain("Tesouraria agora");
    expect($("#previa-clube")).toBeNull();
    expect($<HTMLInputElement>("#pf").value).toBe("0,25");
  });
});
