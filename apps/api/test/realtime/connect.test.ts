import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealtimeGateway } from "../../src/infra/realtime/gateway.js";
import { startApp, TestClient, WEB_ORIGIN, type RunningApp } from "../support/ws-client.js";

describe("conexão em /ws (T1)", () => {
  let running: RunningApp;
  let gateway: RealtimeGateway;

  beforeAll(async () => {
    running = await startApp();
    gateway = running.app.get(RealtimeGateway);
  });
  afterAll(() => running.close());

  it("C5: sem login, o visitante conecta em /ws e a conexão fica registrada sem dono", async () => {
    const client = await TestClient.open(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN });
    expect(gateway.snapshot()).toEqual([{ userId: null, role: "visitor" }]);
    await client.close();
  });

  it("C6: o upgrade com origem diferente de WEB_ORIGIN é recusado", async () => {
    expect(await TestClient.tryOpen(`${running.wsUrl}/ws`, { origin: "https://outro.exemplo" })).toBe(403);
    expect(gateway.snapshot()).toEqual([]);
  });

  it("C6: conexão sem cabeçalho de origem (não é navegador) também é recusada", async () => {
    expect(await TestClient.tryOpen(`${running.wsUrl}/ws`)).toBe(403);
  });

  it("C6: um ?token= na URL não autentica nada: a conexão segue como visitante", async () => {
    const client = await TestClient.open(`${running.wsUrl}/ws?token=qualquer-coisa`, { origin: WEB_ORIGIN });
    expect(gateway.snapshot()).toEqual([{ userId: null, role: "visitor" }]);
    await client.close();
  });

  it("outro caminho no mesmo servidor não vira WebSocket", async () => {
    expect(await TestClient.tryOpen(`${running.wsUrl}/outro`, { origin: WEB_ORIGIN })).not.toBeNull();
  });

  it("a conexão sai do registro quando fecha", async () => {
    const client = await TestClient.open(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN });
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.snapshot()).toEqual([]);
  });
});
