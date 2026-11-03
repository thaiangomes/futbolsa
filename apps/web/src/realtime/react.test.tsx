// @vitest-environment jsdom
import type { Channel, EventEnvelope } from "@futbolsa/contracts";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelHandlers, ClientState } from "./client";
import { RealtimeProvider, RealtimeStatusLine, useChannel, useRealtimeState, useSyncedChannel } from "./react";
import { wsUrlFromApiUrl } from "./url";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Um cliente falso: guarda quem assinou e deixa o teste empurrar estado e eventos. */
class FakeClient {
  state: ClientState = { status: "idle", retryInMs: null, role: "visitor" };
  stateListeners = new Set<(s: ClientState) => void>();
  subscriptions = new Map<Channel, Set<ChannelHandlers>>();
  connect = vi.fn(() => this.setState({ status: "connecting" }));
  disconnect = vi.fn(() => this.setState({ status: "idle" }));
  reconnect = vi.fn();

  // métodos de classe, como no cliente de verdade: quem os solta de `this` quebra
  getState() {
    return this.state;
  }
  onState(listener: (s: ClientState) => void) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  subscribe = vi.fn((channel: Channel, handlers: ChannelHandlers) => {
    const set = this.subscriptions.get(channel) ?? new Set();
    set.add(handlers);
    this.subscriptions.set(channel, set);
    return () => {
      set.delete(handlers);
      if (set.size === 0) this.subscriptions.delete(channel);
    };
  });

  setState(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    this.stateListeners.forEach((l) => l(this.state));
  }
  emit(channel: Channel, event: EventEnvelope) {
    this.subscriptions.get(channel)?.forEach((h) => h.onEvent(event));
  }
}

const event = (seq: number, data: unknown = { n: seq }): EventEnvelope => ({
  type: "trade",
  channel: "club:FLA3",
  seq,
  at: "2026-11-02T15:00:00.000Z",
  data: data as EventEnvelope["data"],
});

describe("provedor e ganchos do tempo real (T11)", () => {
  let container: HTMLElement;
  let root: Root;
  let client: FakeClient;
  const makeClient = vi.fn();

  function render(children: ReactNode) {
    act(() => {
      root.render(createElement(RealtimeProvider, { createClient: makeClient as never, children }));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new FakeClient();
    makeClient.mockReset().mockReturnValue(client);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("C26: uma conexão só por provedor, mesmo com vários componentes usando o tempo real", () => {
    function Tela({ id }: { id: number }) {
      useChannel("prices", { onEvent: () => {} });
      useChannel("season", { onEvent: () => {} });
      const state = useRealtimeState();
      return createElement("p", { "data-testid": `t${id}` }, state.status);
    }
    render(createElement("div", null, createElement(Tela, { id: 1 }), createElement(Tela, { id: 2 }), createElement(Tela, { id: 3 })));
    expect(makeClient).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("p")).toHaveLength(3);
  });

  it("C26: o provedor desconecta ao sair", () => {
    render(createElement("span"));
    act(() => root.unmount());
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    root = createRoot(container); // para o afterEach desmontar sem erro
  });

  it("C26: o gancho assina ao montar e desassina ao desmontar", () => {
    const onEvent = vi.fn();
    function Tela() {
      useChannel("club:FLA3", { onEvent });
      return null;
    }
    render(createElement(Tela));
    expect(client.subscriptions.get("club:FLA3")?.size).toBe(1);
    act(() => client.emit("club:FLA3", event(1)));
    expect(onEvent).toHaveBeenCalledTimes(1);

    render(createElement("span"));
    expect(client.subscriptions.has("club:FLA3")).toBe(false);
  });

  it("o gancho usa sempre a função de tratamento mais nova, sem reassinar a cada renderização", () => {
    const vistos: string[] = [];
    function Tela({ rotulo }: { rotulo: string }) {
      useChannel("club:FLA3", { onEvent: () => vistos.push(rotulo) });
      return null;
    }
    render(createElement(Tela, { rotulo: "a" }));
    render(createElement(Tela, { rotulo: "b" }));
    expect(client.subscribe).toHaveBeenCalledTimes(1);
    act(() => client.emit("club:FLA3", event(1)));
    expect(vistos).toEqual(["b"]);
  });

  it("useRealtimeState acompanha o estado do cliente", () => {
    function Estado() {
      const s = useRealtimeState();
      return createElement("p", null, `${s.status}/${s.retryInMs}`);
    }
    render(createElement(Estado));
    expect(container.textContent).toBe("connecting/null");
    act(() => client.setState({ status: "reconnecting", retryInMs: 2_000 }));
    expect(container.textContent).toBe("reconnecting/2000");
  });

  it("a linha de diagnóstico mostra conectado, reconectando com o tempo e o papel", () => {
    render(createElement(RealtimeStatusLine));
    act(() => client.setState({ status: "open", role: "visitor" }));
    expect(container.textContent).toContain("conectado");
    act(() => client.setState({ status: "open", role: "player" }));
    expect(container.textContent).toContain("conectado");
    expect(container.textContent).toContain("jogador");
    act(() => client.setState({ status: "reconnecting", retryInMs: 4_000 }));
    expect(container.textContent).toContain("reconectando");
    expect(container.textContent).toContain("4 s");
  });

  it("useSyncedChannel carrega, aplica os eventos e solta a assinatura ao sair", async () => {
    const load = vi.fn(async () => ({ state: [0] as number[], seq: 10 }));
    const apply = (s: number[], e: EventEnvelope) => [...s, (e.data as { n: number }).n];
    function Livro() {
      const snap = useSyncedChannel<number[]>("club:FLA3", load, apply);
      return createElement("p", null, `${snap.status}:${JSON.stringify(snap.state)}`);
    }
    render(createElement(Livro));
    expect(container.textContent).toBe("loading:null");
    await act(async () => {});
    expect(container.textContent).toBe("ready:[0]");
    act(() => client.emit("club:FLA3", event(11)));
    expect(container.textContent).toBe("ready:[0,11]");

    render(createElement("span"));
    expect(client.subscriptions.has("club:FLA3")).toBe(false);
  });

  describe("login (T13)", () => {
    /** O login do site falso: o teste entra, sai e renova o token. */
    function fakeAuth(initial: string | null) {
      let token = initial;
      const listeners = new Set<() => void>();
      return {
        getAccessToken: vi.fn(async (_options?: { forceRefresh?: boolean }) => token),
        onChange: vi.fn((listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        set(next: string | null) {
          token = next;
          listeners.forEach((l) => l());
        },
        listeners,
      };
    }
    const settle = () => act(async () => {});

    function renderWith(auth: ReturnType<typeof fakeAuth>) {
      act(() => {
        root.render(createElement(RealtimeProvider, { createClient: makeClient as never, auth, children: createElement("span") }));
      });
    }

    it("C28: o cliente pega o token do login a cada conexão, repassando o forceRefresh", async () => {
      const auth = fakeAuth("tok-1");
      renderWith(auth);
      await settle();
      const options = makeClient.mock.calls[0]![0] as { getToken(o?: { forceRefresh?: boolean }): Promise<string | null> };
      expect(await options.getToken()).toBe("tok-1");
      expect(auth.getAccessToken).toHaveBeenLastCalledWith(undefined);
      await options.getToken({ forceRefresh: true });
      expect(auth.getAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    });

    it("C28: entrar reabre a conexão com o token certo, e sair reabre como visitante", async () => {
      const auth = fakeAuth(null);
      renderWith(auth);
      await settle();
      expect(client.reconnect).not.toHaveBeenCalled();

      auth.set("tok-1"); // entrou
      await settle();
      expect(client.reconnect).toHaveBeenCalledTimes(1);

      auth.set(null); // saiu
      await settle();
      expect(client.reconnect).toHaveBeenCalledTimes(2);
    });

    it("C28: a renovação do token (continua logado) não derruba a conexão", async () => {
      const auth = fakeAuth("tok-1");
      renderWith(auth);
      await settle();
      auth.set("tok-2");
      await settle();
      auth.set("tok-3");
      await settle();
      expect(client.reconnect).not.toHaveBeenCalled();
    });

    it("C28: ao sair da página o provedor para de ouvir o login", async () => {
      const auth = fakeAuth("tok-1");
      renderWith(auth);
      await settle();
      expect(auth.listeners.size).toBe(1);
      act(() => root.unmount());
      expect(auth.listeners.size).toBe(0);
      root = createRoot(container);
    });

    it("sem login configurado, o provedor entra como visitante e não ouve nada", async () => {
      render(createElement("span"));
      await settle();
      const options = makeClient.mock.calls[0]![0] as { getToken(): Promise<string | null> };
      expect(await options.getToken()).toBeNull();
    });
  });

  it("sem provedor, os ganchos dizem o que faltou", () => {
    function Solta() {
      useRealtimeState();
      return null;
    }
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => act(() => createRoot(document.createElement("div")).render(createElement(Solta)))).toThrow(
      /RealtimeProvider/,
    );
    erro.mockRestore();
  });
});

describe("endereço do WebSocket", () => {
  it("troca http por ws, https por wss e acrescenta /ws", () => {
    expect(wsUrlFromApiUrl("http://localhost:3000")).toBe("ws://localhost:3000/ws");
    expect(wsUrlFromApiUrl("https://api.futbolsa.com.br")).toBe("wss://api.futbolsa.com.br/ws");
    expect(wsUrlFromApiUrl("https://api.exemplo.com/")).toBe("wss://api.exemplo.com/ws");
  });
});
