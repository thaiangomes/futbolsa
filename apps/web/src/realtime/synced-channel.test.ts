import type { Channel, EventEnvelope } from "@futbolsa/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelHandlers } from "./client";
import { SyncedChannel } from "./synced-channel";

const AT = "2026-11-02T15:00:00.000Z";
const event = (seq: number, data: unknown = { n: seq }): EventEnvelope => ({
  type: "trade",
  channel: "club:FLA3",
  seq,
  at: AT,
  data: data as EventEnvelope["data"],
});

/** O estado do teste é a lista dos `n` aplicados, na ordem. */
type State = number[];
const apply = (state: State, e: EventEnvelope): State => [...state, (e.data as { n: number }).n];

/** O cliente falso guarda o que o canal sincronizado assinou. */
class FakeClient {
  handlers: ChannelHandlers | null = null;
  subscribedTo: Channel[] = [];
  unsubscribed = 0;
  subscribe(channel: Channel, handlers: ChannelHandlers) {
    this.handlers = handlers;
    this.subscribedTo.push(channel);
    return () => {
      this.unsubscribed++;
      this.handlers = null;
    };
  }
}

/** Uma carga controlada pelo teste: resolve quando o teste quiser. */
function deferredLoads() {
  const pending: Array<{ resolve: (v: { state: State; seq: number }) => void; reject: (e: Error) => void }> = [];
  const load = vi.fn(
    () =>
      new Promise<{ state: State; seq: number }>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { load, pending };
}

describe("canal sincronizado: REST + eventos (T10)", () => {
  let client: FakeClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new FakeClient();
  });
  afterEach(() => vi.useRealTimers());

  function make(load: ReturnType<typeof deferredLoads>["load"]) {
    const channel = new SyncedChannel<State>({ client, channel: "club:FLA3", load, apply });
    channel.start();
    return channel;
  }
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it("assina antes de carregar", () => {
    const { load } = deferredLoads();
    make(load);
    expect(client.subscribedTo).toEqual(["club:FLA3"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(client.handlers?.since?.()).toBeUndefined();
  });

  it("C25: o evento que chega durante a carga é guardado; com a carga em seq 100, o 99 e o 100 são descartados e o 101 é aplicado", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    client.handlers!.onEvent(event(99));
    client.handlers!.onEvent(event(100));
    client.handlers!.onEvent(event(101));
    expect(channel.getSnapshot()).toEqual({ status: "loading", state: null });

    pending[0]!.resolve({ state: [1000], seq: 100 });
    await settle();
    expect(channel.getSnapshot()).toEqual({ status: "ready", state: [1000, 101] });
    expect(client.handlers!.since?.()).toBe(101);
  });

  it("C25: o que chega depois da carga é aplicado na hora, em ordem", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    pending[0]!.resolve({ state: [], seq: 10 });
    await settle();
    client.handlers!.onEvent(event(11));
    client.handlers!.onEvent(event(12));
    expect(channel.getSnapshot().state).toEqual([11, 12]);
  });

  it("C22: repetido e antigo são descartados", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    pending[0]!.resolve({ state: [], seq: 10 });
    await settle();
    client.handlers!.onEvent(event(11));
    client.handlers!.onEvent(event(11));
    client.handlers!.onEvent(event(5));
    expect(channel.getSnapshot().state).toEqual([11]);
  });

  it("C25: buraco depois da carga recarrega e não aplica o evento que pulou", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    pending[0]!.resolve({ state: [], seq: 10 });
    await settle();
    client.handlers!.onEvent(event(11));
    client.handlers!.onEvent(event(13)); // faltou o 12
    expect(load).toHaveBeenCalledTimes(2);
    expect(channel.getSnapshot()).toMatchObject({ status: "loading" });
    expect(channel.getSnapshot().state).toEqual([11]); // a tela mantém o que tinha enquanto recarrega
    client.handlers!.onEvent(event(14)); // durante a recarga: guardado

    pending[1]!.resolve({ state: [900], seq: 13 });
    await settle();
    expect(channel.getSnapshot()).toEqual({ status: "ready", state: [900, 14] });
  });

  it("C25: 1, 2, 4, 3 depois da carga aplica 1 e 2, recarrega no 4 e não aplica 4 nem 3", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    pending[0]!.resolve({ state: [], seq: 0 });
    await settle();
    for (const seq of [1, 2, 4, 3]) client.handlers!.onEvent(event(seq));
    expect(channel.getSnapshot().state).toEqual([1, 2]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("C25: buraco entre os eventos guardados durante a carga também recarrega", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    client.handlers!.onEvent(event(101));
    client.handlers!.onEvent(event(103));
    pending[0]!.resolve({ state: [], seq: 100 });
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(channel.getSnapshot().state).toEqual([101]);
    pending[1]!.resolve({ state: [7], seq: 103 });
    await settle();
    expect(channel.getSnapshot()).toEqual({ status: "ready", state: [7] });
  });

  it("C25: resync recarrega pela REST", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    pending[0]!.resolve({ state: [1], seq: 10 });
    await settle();
    client.handlers!.onSubscribed!({ seq: 5_000, mode: "resync" });
    expect(load).toHaveBeenCalledTimes(2);
    pending[1]!.resolve({ state: [2], seq: 5_000 });
    await settle();
    expect(channel.getSnapshot()).toEqual({ status: "ready", state: [2] });
  });

  it("subscribed ao vivo ou retomado não recarrega", async () => {
    const { load, pending } = deferredLoads();
    make(load);
    pending[0]!.resolve({ state: [], seq: 10 });
    await settle();
    client.handlers!.onSubscribed!({ seq: 10, mode: "live" });
    client.handlers!.onSubscribed!({ seq: 12, mode: "resumed" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("o resultado de uma carga velha é ignorado quando uma recarga já começou", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    client.handlers!.onSubscribed!({ seq: 9, mode: "resync" }); // pede nova carga com a primeira ainda no ar
    expect(load).toHaveBeenCalledTimes(2);
    pending[0]!.resolve({ state: ["velha" as unknown as number], seq: 5 });
    await settle();
    expect(channel.getSnapshot()).toMatchObject({ status: "loading" });
    pending[1]!.resolve({ state: [42], seq: 9 });
    await settle();
    expect(channel.getSnapshot()).toEqual({ status: "ready", state: [42] });
  });

  it("falha na carga: mostra o erro e tenta de novo depois de 3 segundos", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    pending[0]!.reject(new Error("rede"));
    await settle();
    expect(channel.getSnapshot()).toMatchObject({ status: "error", state: null });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);
    pending[1]!.resolve({ state: [1], seq: 1 });
    await settle();
    expect(channel.getSnapshot().status).toBe("ready");
  });

  it("quem acompanha é avisado a cada mudança, e só dela", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    const vistos: Array<[string, State | null]> = [];
    channel.subscribe(() => vistos.push([channel.getSnapshot().status, channel.getSnapshot().state]));
    pending[0]!.resolve({ state: [], seq: 1 });
    await settle();
    client.handlers!.onEvent(event(2));
    client.handlers!.onEvent(event(2)); // repetido: não muda nada
    expect(vistos).toEqual([
      ["ready", []],
      ["ready", [2]],
    ]);
  });

  it("C25: sair da tela não deixa assinatura nem temporizador, mesmo com carga e retentativa pendentes", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    pending[0]!.reject(new Error("rede")); // deixa uma retentativa agendada
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    channel.stop();
    expect(client.unsubscribed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("C25: o resultado de uma carga que chega depois do stop não muda nada", async () => {
    const { load, pending } = deferredLoads();
    const channel = make(load);
    channel.stop();
    pending[0]!.resolve({ state: [1], seq: 1 });
    await settle();
    expect(channel.getSnapshot()).toEqual({ status: "idle", state: null });
  });
});
