import type { Channel, EventEnvelope } from "@futbolsa/contracts";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach } from "vitest";
import type { ChannelHandlers } from "../realtime/client";
import { RealtimeProvider, type RealtimeClientLike } from "../realtime/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * O cliente de tempo real falso dos testes de tela: guarda quem assinou cada canal e deixa o teste
 * "mandar" um evento como o servidor mandaria.
 */
export class FakeRealtime {
  private readonly handlers = new Map<Channel, Set<ChannelHandlers>>();

  client(): RealtimeClientLike {
    return {
      connect: () => undefined,
      disconnect: () => undefined,
      reconnect: () => undefined,
      subscribe: (channel, handlers) => {
        const set = this.handlers.get(channel) ?? new Set();
        set.add(handlers);
        this.handlers.set(channel, set);
        return () => set.delete(handlers);
      },
      getState: () => ({ status: "idle" as const, retryInMs: null, role: "visitor" as const }),
      onState: () => () => undefined,
    };
  }

  /** Canais com alguém assinando agora. */
  subscribedChannels(): Channel[] {
    return [...this.handlers].filter(([, set]) => set.size > 0).map(([channel]) => channel);
  }

  /** Entrega um evento aos assinantes do canal (dentro do `act`, para a tela atualizar). */
  async emit(channel: Channel, type: string, data: unknown): Promise<void> {
    const event = { type, channel, seq: 1, at: "2027-03-30T12:00:00.000Z", data } as EventEnvelope;
    await act(async () => {
      for (const h of this.handlers.get(channel) ?? []) h.onEvent(event);
    });
  }
}

/**
 * Monta e desmonta uma raiz do React a cada teste e devolve os atalhos que as telas usam (o mesmo
 * jeito dos testes do admin, sem biblioteca a mais). Chamar uma vez dentro do `describe`.
 */
export function useDom(realtime: FakeRealtime = new FakeRealtime()) {
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

  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  };

  return {
    realtime,
    /** Mostra o elemento dentro do provedor de tempo real falso. */
    async render(element: ReactElement) {
      await act(async () => root.render(createElement(RealtimeProvider, { createClient: (() => realtime.client()) as never, children: element })));
    },
    $<T extends Element = HTMLElement>(selector: string): T {
      return container.querySelector(selector) as T;
    },
    $$<T extends Element = HTMLElement>(selector: string): T[] {
      return [...container.querySelectorAll(selector)] as T[];
    },
    text: () => container.textContent ?? "",
    /** O botão com exatamente esse texto (dentro do elemento, se informado). */
    button(label: string, within: ParentNode = container): HTMLButtonElement {
      return [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
    },
    async type(selector: string | HTMLInputElement, value: string, within: ParentNode = container) {
      const input = typeof selector === "string" ? (within.querySelector(selector) as HTMLInputElement) : selector;
      await act(async () => {
        setValue(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    async click(el: Element) {
      await act(async () => {
        (el as HTMLElement).click();
      });
    },
    /** Deixa as promessas pendentes (carregamento, resposta da API) terminarem. */
    async settle() {
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}
