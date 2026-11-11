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

const state = { mmQuantityBp: 25, mmMatchQuantityBp: 6, mmMinSideQty: 10, mmMatchMinSideQty: 3, mmLotBp: 2000 };
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
    const update = vi.fn(async () => ({ ...state, mmQuantityBp: 30, mmMatchMinSideQty: 4 }));
    await render(createElement(MarketMakerScreen, { admin: fake({ updateMarketMaker: update }) }));
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
});
