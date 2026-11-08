import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealtimeAuthenticator } from "../../src/infra/realtime/authenticator.js";
import { EventBus, meChannel } from "../../src/infra/realtime/bus.js";
import { FakeRealtimeAuthenticator } from "../../src/infra/realtime/fake-authenticator.js";
import { startApp, TestClient, WEB_ORIGIN, type RunningApp } from "../support/ws-client.js";

describe("o canal me é privado (T5)", () => {
  let running: RunningApp;
  let bus: EventBus;
  const clients: TestClient[] = [];

  async function open(token?: string, ...channels: string[]): Promise<TestClient> {
    const client = await TestClient.open(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN });
    clients.push(client);
    if (token) await client.ask({ type: "auth", token });
    for (const channel of channels) await client.ask({ type: "subscribe", channel });
    return client;
  }

  beforeAll(async () => {
    running = await startApp();
    bus = running.app.get(EventBus);
    const auth = running.app.get(RealtimeAuthenticator) as FakeRealtimeAuthenticator;
    auth.add("tok-ana", { userId: "ana", role: "player", status: "active" });
    auth.add("tok-beto", { userId: "beto", role: "player", status: "active" });
    auth.add("tok-bloq", { userId: "bloq", role: "player", status: "blocked" });
    auth.add("tok-adm", { userId: "adm", role: "admin", status: "active" });
  });
  afterAll(async () => {
    clients.forEach((c) => c.socket.terminate());
    await running.close();
  });

  it("C9: o evento do me chega só à pessoa, em todas as conexões dela, e nunca a outra pessoa, a visitante nem a admin", async () => {
    const ana1 = await open("tok-ana", "me");
    const ana2 = await open("tok-ana", "me");
    const beto = await open("tok-beto", "me");
    const adm = await open("tok-adm", "me");
    const visitante = await open(undefined);
    expect(await visitante.ask({ type: "subscribe", channel: "me" })).toMatchObject({ data: { code: "unauthorized" } });

    bus.publish(meChannel("ana"), "wallet.changed", { cash: 123_400 });

    for (const conn of [ana1, ana2]) {
      expect(await conn.next()).toMatchObject({ type: "wallet.changed", channel: "me", data: { cash: 123_400 } });
    }
    for (const conn of [beto, adm, visitante]) expect(await conn.quiet()).toBe(true);
  });

  it("C9: o seq do me é por pessoa", async () => {
    const ana = await open("tok-ana", "me");
    const beto = await open("tok-beto", "me");
    bus.publish(meChannel("ana"), "entry.added", { n: 1 });
    bus.publish(meChannel("ana"), "entry.added", { n: 2 });
    bus.publish(meChannel("beto"), "entry.added", { n: 1 });
    const [a1, a2] = [(await ana.next()) as { seq: number }, (await ana.next()) as { seq: number }];
    const b1 = (await beto.next()) as { seq: number };
    expect(a2.seq).toBe(a1.seq + 1);
    expect(b1.seq).toBeGreaterThan(0);
    expect(await beto.quiet()).toBe(true);
  });

  it("C9: o cliente não escolhe de quem é o me: não existe canal me:<id>", async () => {
    const beto = await open("tok-beto");
    expect(await beto.ask({ type: "subscribe", channel: "me:ana" })).toMatchObject({ data: { code: "unknown_channel" } });
  });

  it("C9: retomar o me traz só os eventos da própria pessoa", async () => {
    bus.publish(meChannel("ana"), "order.updated", { o: 1 });
    bus.publish(meChannel("beto"), "order.updated", { o: 2 });
    const antes = bus.currentSeq(meChannel("ana"));
    bus.publish(meChannel("ana"), "order.updated", { o: 3 });
    const ana = await open("tok-ana");
    const reply = await ana.ask({ type: "subscribe", channel: "me", since: antes });
    expect(reply).toMatchObject({ data: { mode: "resumed", seq: antes + 1 } });
    expect(await ana.next()).toMatchObject({ type: "order.updated", data: { o: 3 } });
    expect(await ana.quiet()).toBe(true);
  });

  it("C10: o jogador bloqueado assina o me e recebe", async () => {
    const bloq = await open("tok-bloq");
    expect(await bloq.ask({ type: "subscribe", channel: "me" })).toMatchObject({ type: "subscribed" });
    bus.publish(meChannel("bloq"), "wallet.changed", { cash: 1 });
    expect(await bloq.next()).toMatchObject({ type: "wallet.changed" });
  });

  it("o admin só vê o próprio me, como qualquer pessoa", async () => {
    const adm = await open("tok-adm", "me");
    bus.publish(meChannel("ana"), "wallet.changed", { cash: 9 });
    expect(await adm.quiet()).toBe(true);
    bus.publish(meChannel("adm"), "wallet.changed", { cash: 7 });
    expect(await adm.next()).toMatchObject({ data: { cash: 7 } });
  });

  it("o evento do admin não chega a jogador nem a visitante, mesmo que tentem assinar", async () => {
    const ana = await open("tok-ana");
    const visitante = await open();
    expect(await ana.ask({ type: "subscribe", channel: "admin" })).toMatchObject({ data: { code: "forbidden" } });
    expect(await visitante.ask({ type: "subscribe", channel: "admin" })).toMatchObject({ data: { code: "unauthorized" } });
    bus.publish("admin", "admin.pending", { pendingMatches: 1 });
    expect(await ana.quiet()).toBe(true);
    expect(await visitante.quiet()).toBe(true);
  });

  it("quando a conexão fecha, as assinaturas saem do barramento", async () => {
    const ana = await open("tok-ana", "me");
    await ana.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => bus.publish(meChannel("ana"), "entry.added", {})).not.toThrow();
  });
});
