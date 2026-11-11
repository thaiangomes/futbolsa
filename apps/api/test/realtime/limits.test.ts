import "reflect-metadata";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RealtimeAuthenticator } from "../../src/infra/realtime/authenticator.js";
import { EventBus } from "../../src/infra/realtime/bus.js";
import { FakeRealtimeAuthenticator } from "../../src/infra/realtime/fake-authenticator.js";
import { RealtimeGateway } from "../../src/infra/realtime/gateway.js";
import { startApp, TestClient, WEB_ORIGIN, type RunningApp } from "../support/ws-client.js";
import { tradeData } from "../support/events.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("limites e cliente lento (T6)", () => {
  let running: RunningApp;
  let bus: EventBus;
  let gateway: RealtimeGateway;
  const clients: TestClient[] = [];

  async function open(token?: string): Promise<TestClient> {
    const client = await TestClient.open(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN });
    clients.push(client);
    if (token) await client.ask({ type: "auth", token });
    return client;
  }

  beforeAll(async () => {
    running = await startApp();
    bus = running.app.get(EventBus);
    gateway = running.app.get(RealtimeGateway);
    const auth = running.app.get(RealtimeAuthenticator) as FakeRealtimeAuthenticator;
    for (const id of ["ana", "beto"]) auth.add(`tok-${id}`, { userId: id, role: "player", status: "active" });
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.socket.terminate());
    for (const name of ["WS_MAX_MESSAGES_PER_SECOND", "WS_MAX_CONNECTIONS", "WS_SLOW_CLIENT_BYTES"]) {
      delete process.env[name];
    }
    await sleep(30);
  });
  afterAll(() => running.close());

  describe("mensagens", () => {
    it("C19: mensagem acima de 4 KB fecha com 1009", async () => {
      const client = await open();
      client.send(JSON.stringify({ type: "auth", token: "x".repeat(5_000) }));
      expect(await client.closed).toMatchObject({ code: 1009 });
    });

    it("C19: uma mensagem dentro de 4 KB passa", async () => {
      const client = await open();
      client.send(JSON.stringify({ type: "auth", token: "x".repeat(3_500) }));
      expect(await client.next()).toMatchObject({ type: "auth.error", data: { code: "invalid_token" } });
    });

    it("C19: até 20 mensagens por segundo passam e a 21ª fecha com 1008", async () => {
      const ok = await open();
      for (let i = 0; i < 20; i++) ok.send({ type: "unsubscribe", channel: "prices" });
      await sleep(150);
      expect(ok.socket.readyState).toBe(ok.socket.OPEN);

      const demais = await open();
      for (let i = 0; i < 25; i++) demais.send({ type: "unsubscribe", channel: "prices" });
      expect(await demais.closed).toMatchObject({ code: 1008 });
    });

    it("C19: depois de um segundo parado o ritmo zera", async () => {
      process.env.WS_MAX_MESSAGES_PER_SECOND = "5";
      const client = await open();
      for (let i = 0; i < 5; i++) client.send({ type: "unsubscribe", channel: "prices" });
      await sleep(1_100);
      for (let i = 0; i < 5; i++) client.send({ type: "unsubscribe", channel: "prices" });
      await sleep(150);
      expect(client.socket.readyState).toBe(client.socket.OPEN);
    });
  });

  describe("assinaturas e conexões", () => {
    it("C19: a 41ª assinatura dá too_many_subscriptions e a conexão segue", async () => {
      process.env.WS_MAX_MESSAGES_PER_SECOND = "1000";
      const client = await open();
      const canais = Array.from({ length: 41 }, (_, i) => `club:${String.fromCharCode(65 + (i % 26))}AA${i % 10}`);
      expect(new Set(canais).size).toBe(41);
      for (const channel of canais.slice(0, 40)) {
        expect(await client.ask({ type: "subscribe", channel })).toMatchObject({ type: "subscribed" });
      }
      expect(await client.ask({ type: "subscribe", channel: canais[40] })).toMatchObject({
        type: "error",
        data: { code: "too_many_subscriptions", channel: canais[40] },
      });
      // assinar de novo um canal que já tem não conta como nova assinatura
      expect(await client.ask({ type: "subscribe", channel: canais[0] })).toMatchObject({ type: "subscribed" });
      // liberar uma vaga deixa assinar outra
      client.send({ type: "unsubscribe", channel: canais[0] });
      expect(await client.ask({ type: "subscribe", channel: canais[40] })).toMatchObject({ type: "subscribed" });
    });

    it("C19: a 6ª conexão da mesma pessoa derruba a mais antiga; as de outra pessoa não contam", async () => {
      const ana = [];
      for (let i = 0; i < 5; i++) {
        ana.push(await open("tok-ana"));
        await sleep(5);
      }
      const beto = await open("tok-beto");
      expect(ana.every((c) => c.socket.readyState === c.socket.OPEN)).toBe(true);

      const sexta = await open("tok-ana");
      expect(await ana[0]!.closed).toMatchObject({ code: 1013 });
      expect([...ana.slice(1), sexta, beto].every((c) => c.socket.readyState === c.socket.OPEN)).toBe(true);
      expect(gateway.snapshot().filter((c) => c.userId === "ana")).toHaveLength(5);
    });

    it("C19: acima de WS_MAX_CONNECTIONS a nova conexão é recusada", async () => {
      process.env.WS_MAX_CONNECTIONS = String(gateway.snapshot().length + 2);
      const a = await open();
      const b = await open();
      const c = await open();
      expect(await c.closed).toMatchObject({ code: 1013 });
      expect([a, b].every((x) => x.socket.readyState === x.socket.OPEN)).toBe(true);
    });
  });

  describe("cliente lento", () => {
    it("C20: o cliente que não escoa o envio é derrubado e os demais seguem recebendo", async () => {
      process.env.WS_SLOW_CLIENT_BYTES = String(256 * 1024);
      const lento = await open("tok-ana");
      const rapido = await open("tok-beto");
      await lento.ask({ type: "subscribe", channel: "me" });
      await rapido.ask({ type: "subscribe", channel: "club:LEN1" });
      await lento.ask({ type: "subscribe", channel: "club:LEN1" });
      // o lento para de ler do socket: o que o servidor manda fica parado no envio
      (lento.socket as unknown as { _socket: { pause(): void } })._socket.pause();

      const grande = "x".repeat(20_000);
      const antes = gateway.stats().slowClientsDropped;
      let publicados = 0;
      // um evento por vez, dando tempo de o cliente que lê esvaziar o envio dele
      for (let i = 0; i < 4_000 && gateway.stats().slowClientsDropped === antes; i++) {
        bus.publish("club:LEN1", "trade", { ...tradeData(i), at: grande });
        publicados++;
        await sleep(1);
      }
      await sleep(50);

      expect(gateway.stats().slowClientsDropped).toBe(antes + 1);
      expect(gateway.snapshot().some((c) => c.userId === "ana")).toBe(false);
      expect(gateway.snapshot().some((c) => c.userId === "beto")).toBe(true);
      expect(publicados).toBeLessThan(4_000);

      // quem lê continua recebendo, sem atraso
      bus.publish("club:LEN1", "trade", tradeData(999_999));
      let ultimo: any;
      do ultimo = await rapido.next();
      while (ultimo.data?.id !== 999_999);
      expect(ultimo.data.id).toBe(999_999);
    });
  });
});
