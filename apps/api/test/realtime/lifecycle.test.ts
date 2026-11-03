import "reflect-metadata";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { FixedClock } from "../../src/infra/clock/index.js";
import { RealtimeAuthenticator } from "../../src/infra/realtime/authenticator.js";
import { EventBus } from "../../src/infra/realtime/bus.js";
import { FakeRealtimeAuthenticator } from "../../src/infra/realtime/fake-authenticator.js";
import { RealtimeGateway } from "../../src/infra/realtime/gateway.js";
import { RealtimeLifecycle, type LifecycleSession } from "../../src/infra/realtime/lifecycle.js";
import { startApp, TestClient, WEB_ORIGIN, type RunningApp } from "../support/ws-client.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MINUTE = 60_000;

function stubSession(loggedInAt: number | null) {
  return {
    loggedInAt,
    sendHeartbeat: vi.fn(),
    ping: vi.fn(),
    close: vi.fn(),
  } satisfies LifecycleSession;
}

describe("vida da conexão: a regra, com relógio simulado (T7)", () => {
  const config = { heartbeatMs: 25_000, pingMs: 30_000, maxAgeMs: 55 * MINUTE };
  let clock: FixedClock;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = new FixedClock(new Date("2026-11-02T15:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  /** Anda o relógio da API e os temporizadores juntos (o `Clock` não enxerga o tempo simulado). */
  function advance(ms: number) {
    clock.advance(ms);
    vi.advanceTimersByTime(ms);
  }

  it("C21: o heartbeat vai a todas as conexões a cada 25 segundos", () => {
    const a = stubSession(null);
    const b = stubSession(clock.now().getTime());
    const lifecycle = new RealtimeLifecycle(() => [a, b], clock, config);
    lifecycle.start();
    advance(24_999);
    expect(a.sendHeartbeat).not.toHaveBeenCalled();
    advance(1);
    expect(a.sendHeartbeat).toHaveBeenCalledTimes(1);
    advance(25_000);
    expect(a.sendHeartbeat).toHaveBeenCalledTimes(2);
    expect(b.sendHeartbeat).toHaveBeenCalledTimes(2);
    lifecycle.stop();
  });

  it("C21: o ping sai a cada 30 segundos", () => {
    const a = stubSession(null);
    const lifecycle = new RealtimeLifecycle(() => [a], clock, config);
    lifecycle.start();
    advance(60_000);
    expect(a.ping).toHaveBeenCalledTimes(2);
    lifecycle.stop();
  });

  it("C12: depois de 55 minutos a conexão autenticada fecha com 4402; antes disso e como visitante, não", () => {
    const logada = stubSession(clock.now().getTime());
    const visitante = stubSession(null);
    const lifecycle = new RealtimeLifecycle(() => [logada, visitante], clock, config);
    lifecycle.start();
    advance(54 * MINUTE);
    expect(logada.close).not.toHaveBeenCalled();
    advance(2 * MINUTE);
    expect(logada.close).toHaveBeenCalledWith(4402, expect.any(String));
    expect(visitante.close).not.toHaveBeenCalled();
    lifecycle.stop();
  });

  it("parar o ciclo de vida não deixa temporizador vivo", () => {
    const lifecycle = new RealtimeLifecycle(() => [], clock, config);
    lifecycle.start();
    lifecycle.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("vida da conexão: de ponta a ponta (T7)", () => {
  let running: RunningApp;
  let gateway: RealtimeGateway;
  let bus: EventBus;
  const clients: TestClient[] = [];

  async function open(token?: string): Promise<TestClient> {
    const client = await TestClient.open(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN });
    clients.push(client);
    if (token) await client.ask({ type: "auth", token });
    return client;
  }

  beforeAll(async () => {
    process.env.WS_HEARTBEAT_MS = "100";
    process.env.WS_PING_MS = "100";
    process.env.WS_MAX_AGE_MS = "450";
    running = await startApp();
    gateway = running.app.get(RealtimeGateway);
    bus = running.app.get(EventBus);
    const auth = running.app.get(RealtimeAuthenticator) as FakeRealtimeAuthenticator;
    for (const id of ["ana", "beto"]) auth.add(`tok-${id}`, { userId: id, role: "player", status: "active" });
  });
  afterAll(async () => {
    for (const name of ["WS_HEARTBEAT_MS", "WS_PING_MS", "WS_MAX_AGE_MS"]) delete process.env[name];
    clients.forEach((c) => c.socket.terminate());
    await running.close();
  });

  it("C21: o servidor manda heartbeat no envelope do sistema", async () => {
    const client = await open();
    expect(await client.next(1_000)).toMatchObject({ type: "heartbeat", channel: "system", seq: 0, data: {} });
  });

  it("C21: derruba quem não responde ao ping", async () => {
    const mudo = new WebSocket(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN, autoPong: false });
    await new Promise((resolve) => mudo.once("open", resolve));
    const fechou = new Promise<number>((resolve) => mudo.once("close", resolve));
    // o primeiro ping fica sem resposta; no segundo o servidor corta a conexão (sem quadro de fechamento: 1006)
    expect(await fechou).toBe(1006);
  });

  it("C12: depois do tempo máximo a conexão autenticada fecha com 4402 e a de visitante fica", async () => {
    const logada = await open("tok-ana");
    const visitante = await open();
    expect(await logada.closed).toMatchObject({ code: 4402 });
    expect(visitante.socket.readyState).toBe(visitante.socket.OPEN);
  });

  it("C12: disconnectUser fecha todas as conexões da pessoa com 4403 e as dos outros ficam", async () => {
    const ana1 = await open("tok-ana");
    const ana2 = await open("tok-ana");
    const beto = await open("tok-beto");
    expect(gateway.disconnectUser("ana")).toBe(2);
    expect(await ana1.closed).toMatchObject({ code: 4403 });
    expect(await ana2.closed).toMatchObject({ code: 4403 });
    expect(beto.socket.readyState).toBe(beto.socket.OPEN);
    expect(gateway.disconnectUser("ana")).toBe(0);
  });

  it("C21: stats informa conexões, assinaturas por canal, clientes lentos derrubados e o atraso dos eventos", async () => {
    const a = await open();
    const b = await open();
    await a.ask({ type: "subscribe", channel: "club:STA1" });
    await b.ask({ type: "subscribe", channel: "club:STA1" });
    await b.ask({ type: "subscribe", channel: "season" });
    bus.publish("club:STA1", "trade", { id: "1" });
    await sleep(50);
    const stats = gateway.stats();
    expect(stats.connections).toBeGreaterThanOrEqual(2);
    expect(stats.subscriptions["club:STA1"]).toBe(2);
    expect(stats.subscriptions["season"]).toBe(1);
    expect(stats.slowClientsDropped).toBe(0);
    expect(stats.eventDelay.count).toBeGreaterThanOrEqual(2);
    expect(stats.eventDelay.maxMs).toBeGreaterThanOrEqual(0);
    expect(stats.bufferedBytes).toBeGreaterThanOrEqual(0);
  });
});

describe("desligamento limpo (T7)", () => {
  it("C21: ao desligar, todas as conexões fecham com 1001", async () => {
    const running = await startApp();
    const clients = await Promise.all(
      [1, 2, 3].map(() => TestClient.open(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN })),
    );
    await running.close();
    for (const client of clients) expect(await client.closed).toMatchObject({ code: 1001 });
  });
});
