import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeClient, type ChannelHandlers, type SocketLike } from "./client";

const AT = "2026-11-02T15:00:00.000Z";

/** Um WebSocket falso: o teste decide quando abre, o que chega e quando cai. */
class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = 3;
  }

  // lado do servidor, usado pelo teste
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  system(type: string, data: unknown) {
    this.receive({ type, channel: "system", seq: 0, at: AT, data });
  }
  event(channel: string, seq: number, type = "trade", data: unknown = {}) {
    this.receive({ type, channel, seq, at: AT, data });
  }
}

const last = () => FakeSocket.instances.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

function handlers(overrides: Partial<ChannelHandlers> = {}) {
  const events: Array<{ seq: number }> = [];
  const subscribed: Array<{ seq: number; mode: string }> = [];
  const errors: string[] = [];
  const h: ChannelHandlers = {
    onEvent: (e) => events.push(e),
    onSubscribed: (info) => subscribed.push(info),
    onError: (code) => errors.push(code),
    ...overrides,
  };
  return { h, events, subscribed, errors };
}

describe("cliente do WebSocket (T9)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  function make(options: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
    return new RealtimeClient({
      url: "ws://api.exemplo/ws",
      createSocket: (url) => new FakeSocket(url),
      random: () => 1,
      ...options,
    });
  }

  it("abre a conexão no endereço dado e assina o que foi pedido, sem login", async () => {
    const client = make();
    const { h } = handlers();
    client.subscribe("prices", h);
    client.subscribe("club:FLA3", handlers().h);
    client.connect();
    await flush();
    expect(last().url).toBe("ws://api.exemplo/ws");
    expect(last().sent).toEqual([]);
    last().open();
    expect(last().sent).toEqual([
      { type: "subscribe", channel: "prices" },
      { type: "subscribe", channel: "club:FLA3" },
    ]);
    expect(client.getState().status).toBe("open");
  });

  it("assinar com a conexão aberta manda na hora; cancelar manda unsubscribe e some da reassinatura", async () => {
    const client = make();
    client.connect();
    await flush();
    last().open();
    const cancel = client.subscribe("season", handlers().h);
    expect(last().sent).toEqual([{ type: "subscribe", channel: "season" }]);
    cancel();
    expect(last().sent.at(-1)).toEqual({ type: "unsubscribe", channel: "season" });
    last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    last().open();
    expect(last().sent).toEqual([]);
  });

  it("C24: com login, manda auth como primeira mensagem, antes das assinaturas", async () => {
    const client = make({ getToken: async () => "tok-1" });
    client.subscribe("me", handlers().h);
    client.connect();
    await flush();
    last().open();
    expect(last().sent).toEqual([
      { type: "auth", token: "tok-1" },
      { type: "subscribe", channel: "me" },
    ]);
  });

  it("C24: ao cair, reconecta com o recuo e manda auth com um token novo", async () => {
    let n = 0;
    const getToken = vi.fn(async () => `tok-${++n}`);
    const client = make({ getToken });
    client.connect();
    await flush();
    last().open();
    expect(last().sent[0]).toEqual({ type: "auth", token: "tok-1" });

    last().serverClose(1006);
    expect(client.getState()).toMatchObject({ status: "reconnecting", retryInMs: 1_000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    last().open();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(last().sent[0]).toEqual({ type: "auth", token: "tok-2" });

    // segunda queda seguida: espera 2 s
    last().serverClose(1006);
    expect(client.getState().retryInMs).toBe(2_000);
  });

  it("C24: reassina com since = último seq aplicado de cada canal", async () => {
    const client = make();
    const fla = handlers({ since: () => 120 });
    const pal = handlers({ since: () => undefined });
    client.subscribe("club:FLA3", fla.h);
    client.subscribe("club:PAL1", pal.h);
    client.connect();
    await flush();
    last().open();
    expect(last().sent).toEqual([
      { type: "subscribe", channel: "club:FLA3", since: 120 },
      { type: "subscribe", channel: "club:PAL1" },
    ]);
  });

  it("entrega o evento só a quem assinou o canal, e o subscribed com o modo", async () => {
    const client = make();
    const fla = handlers();
    const pal = handlers();
    client.subscribe("club:FLA3", fla.h);
    client.subscribe("club:PAL1", pal.h);
    client.connect();
    await flush();
    last().open();
    last().system("subscribed", { channel: "club:FLA3", seq: 50, mode: "live" });
    last().event("club:FLA3", 51);
    last().event("club:PAL1", 7);
    expect(fla.subscribed).toEqual([{ seq: 50, mode: "live" }]);
    expect(fla.events.map((e) => e.seq)).toEqual([51]);
    expect(pal.events.map((e) => e.seq)).toEqual([7]);
    expect(pal.subscribed).toEqual([]);
  });

  it("C24: trata resync avisando quem assinou, para recarregar", async () => {
    const client = make();
    const fla = handlers();
    client.subscribe("club:FLA3", fla.h);
    client.connect();
    await flush();
    last().open();
    last().system("subscribed", { channel: "club:FLA3", seq: 900, mode: "resync" });
    expect(fla.subscribed).toEqual([{ seq: 900, mode: "resync" }]);
  });

  it("entrega o erro de um canal a quem o assinou", async () => {
    const client = make();
    const me = handlers();
    client.subscribe("me", me.h);
    client.connect();
    await flush();
    last().open();
    last().system("error", { code: "unauthorized", channel: "me" });
    expect(me.errors).toEqual(["unauthorized"]);
  });

  it("ignora quadros que não são do protocolo", async () => {
    const client = make();
    const fla = handlers();
    client.subscribe("club:FLA3", fla.h);
    client.connect();
    await flush();
    last().open();
    last().receive("{quebrado");
    last().receive({ type: "trade" });
    last().event("club:FLA3", 1);
    expect(fla.events).toHaveLength(1);
  });

  describe("silêncio", () => {
    it("C24: depois de 60 segundos sem nada, derruba a conexão e reconecta", async () => {
      const client = make();
      client.connect();
      await flush();
      last().open();
      const primeira = last();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(primeira.closedWith).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(primeira.closedWith).not.toBeNull();
      expect(client.getState().status).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeSocket.instances).toHaveLength(2);
    });

    it("C24: o heartbeat e qualquer mensagem zeram a contagem", async () => {
      const client = make();
      client.connect();
      await flush();
      last().open();
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(25_000);
        last().system("heartbeat", {});
      }
      expect(last().closedWith).toBeNull();
      expect(client.getState().status).toBe("open");
    });
  });

  describe("códigos de fechamento", () => {
    async function connected(options: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
      const client = make(options);
      client.connect();
      await flush();
      last().open();
      await vi.advanceTimersByTimeAsync(2_000); // uma conexão que durou, para o recuo não interferir
      return client;
    }

    it("C24: 4402 reabre na hora com token novo", async () => {
      let n = 0;
      const getToken = vi.fn(async (_o?: { forceRefresh?: boolean }) => `tok-${++n}`);
      await connected({ getToken });
      last().serverClose(4402);
      await flush();
      expect(FakeSocket.instances).toHaveLength(2);
      expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    });

    it("C24: 4403 reabre na hora com o login atual", async () => {
      const getToken = vi.fn(async (_o?: { forceRefresh?: boolean }) => null);
      await connected({ getToken });
      last().serverClose(4403);
      await flush();
      expect(FakeSocket.instances).toHaveLength(2);
      expect(last().readyState).toBe(0);
    });

    it("C24: 4401 pede um token novo uma vez; se falhar de novo, vira visitante e não fica em laço", async () => {
      const getToken = vi.fn(async (_o?: { forceRefresh?: boolean }) => "tok-ruim");
      const client = await connected({ getToken });

      last().serverClose(4401);
      await flush();
      expect(FakeSocket.instances).toHaveLength(2);
      expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
      last().open();
      expect(last().sent[0]).toEqual({ type: "auth", token: "tok-ruim" });

      last().serverClose(4401);
      await flush();
      // terceira conexão: sem token, como visitante
      expect(FakeSocket.instances).toHaveLength(3);
      last().open();
      expect(last().sent.some((m) => m.type === "auth")).toBe(false);
      expect(client.getState().role).toBe("visitor");
      expect(getToken).toHaveBeenCalledTimes(2);

      // e dali em diante não pede mais token por conta própria
      last().serverClose(1006);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getToken).toHaveBeenCalledTimes(2);
    });

    it("um auth.ok zera a conta do 4401", async () => {
      const getToken = vi.fn(async (_o?: { forceRefresh?: boolean }) => "tok");
      const client = await connected({ getToken });
      last().serverClose(4401);
      await flush();
      last().open();
      last().system("auth.ok", { role: "player" });
      expect(client.getState().role).toBe("player");
      await vi.advanceTimersByTimeAsync(2_000);
      last().serverClose(4401);
      await flush();
      // pediu token novo de novo (e não virou visitante), porque o login anterior deu certo
      expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
      expect(FakeSocket.instances).toHaveLength(3);
      last().open();
      expect(last().sent[0]).toEqual({ type: "auth", token: "tok" });
    });

    it.each([1001, 1008, 1009, 1013, 4408, 1006])("%i reconecta com recuo", async (code) => {
      const client = await connected();
      last().serverClose(code);
      expect(client.getState()).toMatchObject({ status: "reconnecting", retryInMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeSocket.instances).toHaveLength(2);
    });

    it("4402 repetido logo após abrir cai no recuo, sem laço apertado", async () => {
      const client = make();
      client.connect();
      await flush();
      last().open();
      last().serverClose(4402); // durou 0 ms
      expect(client.getState().status).toBe("reconnecting");
    });
  });

  describe("recuo", () => {
    it("C23: o recuo volta a 1 segundo depois de uma conexão que se manteve aberta", async () => {
      const client = make();
      client.connect();
      await flush();
      last().open();
      last().serverClose(1006);
      expect(client.getState().retryInMs).toBe(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      last().open();
      last().serverClose(1006);
      expect(client.getState().retryInMs).toBe(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      last().open();
      await vi.advanceTimersByTimeAsync(20_000);
      last().serverClose(1006);
      expect(client.getState().retryInMs).toBe(1_000);
    });

    it("falha ao abrir (nunca abriu) também recua e cresce", async () => {
      const client = make();
      client.connect();
      await flush();
      last().serverClose(1006);
      expect(client.getState().retryInMs).toBe(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      last().serverClose(1006);
      expect(client.getState().retryInMs).toBe(2_000);
    });
  });

  describe("encerrar", () => {
    it("disconnect fecha, não reconecta e não deixa temporizador vivo", async () => {
      const client = make();
      client.connect();
      await flush();
      last().open();
      client.disconnect();
      expect(last().closedWith).not.toBeNull();
      last().serverClose(1000);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(client.getState().status).toBe("idle");
    });

    it("disconnect no meio da espera do recuo cancela a reconexão", async () => {
      const client = make();
      client.connect();
      await flush();
      last().open();
      last().serverClose(1006);
      client.disconnect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it("disconnect enquanto espera o token não abre conexão", async () => {
      let liberar!: (token: string) => void;
      const client = make({ getToken: () => new Promise<string>((resolve) => (liberar = resolve)) });
      client.connect();
      client.disconnect();
      liberar("tok");
      await flush();
      expect(FakeSocket.instances).toHaveLength(0);
    });

    it("reconnect (entrar ou sair no site) abre uma conexão nova na hora, com o login atual", async () => {
      let token: string | null = null;
      const client = make({ getToken: async () => token });
      client.connect();
      await flush();
      const antiga = last();
      antiga.open();
      token = "tok-novo";
      client.reconnect();
      await flush();
      expect(antiga.closedWith).not.toBeNull();
      expect(FakeSocket.instances).toHaveLength(2);
      last().open();
      expect(last().sent[0]).toEqual({ type: "auth", token: "tok-novo" });
    });
  });

  it("token que falha ao ser obtido conecta como visitante", async () => {
    const client = make({
      getToken: async () => {
        throw new Error("sem sessão");
      },
    });
    client.connect();
    await flush();
    last().open();
    expect(last().sent.some((m) => m.type === "auth")).toBe(false);
    expect(client.getState().status).toBe("open");
  });

  it("notifica quem acompanha o estado a cada mudança", async () => {
    const client = make();
    const estados: string[] = [];
    client.onState((s) => estados.push(s.status));
    client.connect();
    await flush();
    last().open();
    last().serverClose(1006);
    expect(estados).toEqual(["connecting", "open", "reconnecting"]);
  });
});
