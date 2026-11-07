import "reflect-metadata";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthVerifier } from "../../src/infra/auth-adapter/index.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { users } from "../../src/infra/db/schema/index.js";
import { EventBus, meChannel } from "../../src/infra/realtime/bus.js";
import { RealtimeGateway } from "../../src/infra/realtime/gateway.js";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { createAccount } from "../support/accounts.js";
import { strangerKeys, TOKEN_T0, tokenFor } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { startApp, TestClient, WEB_ORIGIN, type RunningApp } from "../support/ws-client.js";

/** O login do WebSocket de ponta a ponta: token do Supabase de teste, banco e contas de verdade. */
describe("login do tempo real com as contas da F5 (T12)", () => {
  const database = useTestDatabase(10);
  const verifierClock = new FixedClock(TOKEN_T0);
  let running: RunningApp;
  let bus: EventBus;
  const clients: TestClient[] = [];

  async function open(): Promise<TestClient> {
    const client = await TestClient.open(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN });
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    running = await startApp({ realAuth: { db: database.db, verifierClock } });
    bus = running.app.get(EventBus);
  });
  afterAll(async () => {
    clients.forEach((c) => c.socket.terminate());
    await running?.close();
  });

  it("C27: jogador ativo entra como player e recebe o próprio me", async () => {
    const ana = await createAccount(database.db);
    const client = await open();
    expect(await client.ask({ type: "auth", token: ana.token })).toMatchObject({
      type: "auth.ok",
      data: { role: "player" },
    });
    expect(await client.ask({ type: "subscribe", channel: "me" })).toMatchObject({ type: "subscribed" });
    bus.publish(meChannel(ana.id), "wallet.changed", { cash: 100_000_00 });
    expect(await client.next()).toMatchObject({ type: "wallet.changed", channel: "me", data: { cash: 100_000_00 } });
  });

  it("C27: admin entra como admin e assina o canal admin", async () => {
    const adm = await createAccount(database.db, { role: "admin" });
    const client = await open();
    expect(await client.ask({ type: "auth", token: adm.token })).toMatchObject({ data: { role: "admin" } });
    expect(await client.ask({ type: "subscribe", channel: "admin" })).toMatchObject({ type: "subscribed" });
  });

  it("C27: jogador bloqueado entra, assina o me e recebe", async () => {
    const bloq = await createAccount(database.db, { status: "blocked" });
    const client = await open();
    expect(await client.ask({ type: "auth", token: bloq.token })).toMatchObject({ data: { role: "player" } });
    expect(await client.ask({ type: "subscribe", channel: "me" })).toMatchObject({ type: "subscribed" });
    bus.publish(meChannel(bloq.id), "entry.added", { n: 1 });
    expect(await client.next()).toMatchObject({ type: "entry.added" });
  });

  it("C27: quem tem login mas não tem conta do jogo recebe no_account e segue como visitante", async () => {
    const token = await tokenFor({ subject: "sem-conta-no-jogo" });
    const client = await open();
    expect(await client.ask({ type: "auth", token })).toMatchObject({ type: "auth.error", data: { code: "no_account" } });
    expect(await client.ask({ type: "subscribe", channel: "prices" })).toMatchObject({ type: "subscribed" });
    expect(await client.ask({ type: "subscribe", channel: "me" })).toMatchObject({ data: { code: "unauthorized" } });
  });

  it("C27: e-mail sem confirmação não entra", async () => {
    const token = await tokenFor({ subject: "email-nao-confirmado", emailVerified: false });
    const client = await open();
    expect(await client.ask({ type: "auth", token })).toMatchObject({ data: { code: "no_account" } });
  });

  it("C27: conta excluída recebe account_deleted e segue como visitante", async () => {
    const velha = await createAccount(database.db);
    await database.db.update(users).set({ status: "deleted", email: null, nickname: null, deletedAt: new Date() }).where(eq(users.id, velha.id));
    const client = await open();
    expect(await client.ask({ type: "auth", token: velha.token })).toMatchObject({
      type: "auth.error",
      data: { code: "account_deleted" },
    });
    expect(client.socket.readyState).toBe(client.socket.OPEN);
  });

  it("C7: token vencido, de outra chave ou lixo fecha com 4401", async () => {
    const ana = await createAccount(database.db);
    const vencido = await ana.tokenWith({ at: new Date(TOKEN_T0.getTime() - 2 * 3600_000) });
    const deOutraChave = await ana.tokenWith({ privateKey: strangerKeys.privateKey });
    for (const token of [vencido, deOutraChave, "isto-nao-e-um-jwt"]) {
      const client = await open();
      expect(await client.ask({ type: "auth", token })).toMatchObject({ data: { code: "invalid_token" } });
      expect(await client.closed).toMatchObject({ code: 4401 });
    }
  });

  it("excluir a conta derruba as conexões da pessoa com 4403, e as dos outros ficam", async () => {
    const ana = await createAccount(database.db);
    const bia = await createAccount(database.db);
    const celular = await open();
    const computador = await open();
    const daBia = await open();
    await celular.ask({ type: "auth", token: ana.token });
    await computador.ask({ type: "auth", token: ana.token });
    await daBia.ask({ type: "auth", token: bia.token });

    await running.app.get(AccountDeletionService).deleteAccount(ana.id);

    expect(await celular.closed).toMatchObject({ code: 4403 });
    expect(await computador.closed).toMatchObject({ code: 4403 });
    expect(daBia.socket.readyState).toBe(daBia.socket.OPEN);
    expect(await daBia.ask({ type: "subscribe", channel: "me" })).toMatchObject({ type: "subscribed" });
    // a identidade já foi apagada: o token antigo não acha mais conta nenhuma
    const nova = await open();
    expect(await nova.ask({ type: "auth", token: ana.token })).toMatchObject({ data: { code: "no_account" } });
  });

  it("com o sistema de login fora do ar, a exclusão derruba a conexão do mesmo jeito", async () => {
    const ana = await createAccount(database.db);
    const client = await open();
    await client.ask({ type: "auth", token: ana.token });
    const fora = vi.spyOn(running.app.get(AuthVerifier), "deleteIdentity").mockRejectedValueOnce(new Error("fora do ar"));

    await running.app.get(AccountDeletionService).deleteAccount(ana.id);

    expect(fora).toHaveBeenCalledOnce();
    fora.mockRestore();
    expect(await client.closed).toMatchObject({ code: 4403 });
    const nova = await open();
    expect(await nova.ask({ type: "auth", token: ana.token })).toMatchObject({ data: { code: "account_deleted" } });
  });

  it("exclusão recusada não derruba ninguém", async () => {
    await database.db.update(users).set({ role: "player" }).where(eq(users.role, "admin"));
    const unica = await createAccount(database.db, { role: "admin" });
    const client = await open();
    await client.ask({ type: "auth", token: unica.token });

    await expect(running.app.get(AccountDeletionService).deleteAccount(unica.id)).rejects.toMatchObject({ code: "last_admin" });

    expect(client.socket.readyState).toBe(client.socket.OPEN);
    expect(await client.ask({ type: "subscribe", channel: "admin" })).toMatchObject({ type: "subscribed" });
  });

  it("C12: disconnectUser, como o bloqueio vai usar, derruba a pessoa com 4403", async () => {
    const ana = await createAccount(database.db);
    const client = await open();
    await client.ask({ type: "auth", token: ana.token });
    expect(running.app.get(RealtimeGateway).disconnectUser(ana.id)).toBe(1);
    expect(await client.closed).toMatchObject({ code: 4403 });
    // reabrir depois de excluída: account_deleted
    await database.db.update(users).set({ status: "deleted", email: null, nickname: null, deletedAt: new Date() }).where(eq(users.id, ana.id));
    const nova = await open();
    expect(await nova.ask({ type: "auth", token: ana.token })).toMatchObject({ data: { code: "account_deleted" } });
  });
});
