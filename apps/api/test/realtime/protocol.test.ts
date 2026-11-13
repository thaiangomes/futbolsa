import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealtimeAuthenticator } from "../../src/infra/realtime/authenticator.js";
import { EventBus } from "../../src/infra/realtime/bus.js";
import { FakeRealtimeAuthenticator } from "../../src/infra/realtime/fake-authenticator.js";
import { startApp, TestClient, WEB_ORIGIN, type RunningApp } from "../support/ws-client.js";
import { seasonStatusData, priceData, tradeData } from "../support/events.js";

describe("protocolo do gateway (T5)", () => {
  let running: RunningApp;
  let bus: EventBus;
  let auth: FakeRealtimeAuthenticator;
  const clients: TestClient[] = [];

  async function open(): Promise<TestClient> {
    const client = await TestClient.open(`${running.wsUrl}/ws`, { origin: WEB_ORIGIN });
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    process.env.WS_FIRST_MESSAGE_TIMEOUT_MS = "300";
    running = await startApp();
    bus = running.app.get(EventBus);
    auth = running.app.get(RealtimeAuthenticator) as FakeRealtimeAuthenticator;
    auth.add("tok-ana", { userId: "ana", role: "player", status: "active" });
    auth.add("tok-adm", { userId: "adm", role: "admin", status: "active" });
    auth.addFailure("tok-sem-conta", "no_account");
    auth.addFailure("tok-excluida", "account_deleted");
  });
  afterAll(async () => {
    delete process.env.WS_FIRST_MESSAGE_TIMEOUT_MS;
    clients.forEach((c) => c.socket.terminate());
    await running.close();
  });

  describe("visitante", () => {
    it("C5: sem login assina season, prices, rankings e club:FLA3 e recebe os eventos publicados neles", async () => {
      const client = await open();
      for (const channel of ["season", "prices", "rankings", "club:FLA3"]) {
        const reply = await client.ask({ type: "subscribe", channel });
        expect(reply).toMatchObject({ type: "subscribed", channel: "system", seq: 0, data: { channel, mode: "live" } });
        expect(reply.data.seq).toBe(bus.currentSeq(channel as "season"));
      }
      bus.publish("season", "season.status", seasonStatusData("ipo_open"));
      bus.publish("prices", "price", priceData(100));
      bus.publish("rankings", "rankings.live", { period: "month", periodKey: "2027-06", computedAt: "2027-06-01T00:00:00.000Z", total: 0, top: [] });
      bus.publish("club:FLA3", "trade", tradeData(1));
      const recebidos = [await client.next(), await client.next(), await client.next(), await client.next()] as Array<{
        type: string;
        channel: string;
        seq: number;
      }>;
      expect(recebidos.map((m) => [m.type, m.channel])).toEqual([
        ["season.status", "season"],
        ["price", "prices"],
        ["rankings.live", "rankings"],
        ["trade", "club:FLA3"],
      ]);
      recebidos.forEach((m) => expect(m.seq).toBeGreaterThan(0));
    });
  });

  describe("login", () => {
    it("C7: auth válido como primeira mensagem responde auth.ok com o papel e nada mais", async () => {
      const client = await open();
      const reply = await client.ask({ type: "auth", token: "tok-ana" });
      expect(reply).toMatchObject({ type: "auth.ok", channel: "system", seq: 0, data: { role: "player" } });
      expect(JSON.stringify(reply)).not.toContain("ana");
      const adm = await open();
      expect((await adm.ask({ type: "auth", token: "tok-adm" })).data).toEqual({ role: "admin" });
    });

    it("C7: token inválido responde auth.error e fecha com 4401", async () => {
      const client = await open();
      const reply = await client.ask({ type: "auth", token: "lixo" });
      expect(reply).toMatchObject({ type: "auth.error", data: { code: "invalid_token" } });
      expect(await client.closed).toMatchObject({ code: 4401 });
    });

    it.each([
      ["tok-sem-conta", "no_account"],
      ["tok-excluida", "account_deleted"],
    ])("C7: %s responde auth.error %s e a conexão segue como visitante", async (token, code) => {
      const client = await open();
      expect(await client.ask({ type: "auth", token })).toMatchObject({ type: "auth.error", data: { code } });
      expect(await client.ask({ type: "subscribe", channel: "prices" })).toMatchObject({ type: "subscribed" });
      expect(await client.ask({ type: "subscribe", channel: "me" })).toMatchObject({
        type: "error",
        data: { code: "unauthorized" },
      });
    });

    it("C7: auth depois de outra mensagem dá auth_not_first", async () => {
      const client = await open();
      await client.ask({ type: "subscribe", channel: "prices" });
      expect(await client.ask({ type: "auth", token: "tok-ana" })).toMatchObject({
        type: "error",
        data: { code: "auth_not_first" },
      });
      // e não passou a valer: continua visitante
      expect(await client.ask({ type: "subscribe", channel: "me" })).toMatchObject({ data: { code: "unauthorized" } });
    });

    it("C7: um segundo auth depois de um auth.ok também dá auth_not_first", async () => {
      const client = await open();
      await client.ask({ type: "auth", token: "tok-ana" });
      expect(await client.ask({ type: "auth", token: "tok-adm" })).toMatchObject({ data: { code: "auth_not_first" } });
    });

    it("auth e subscribe mandados juntos são tratados na ordem, sem esperar a resposta do auth", async () => {
      const client = await open();
      client.send({ type: "auth", token: "tok-ana" });
      client.send({ type: "subscribe", channel: "me" });
      expect(await client.next()).toMatchObject({ type: "auth.ok" });
      expect(await client.next()).toMatchObject({ type: "subscribed", data: { channel: "me", mode: "live" } });
    });
  });

  describe("acesso por canal", () => {
    it("C8: sem login, me e admin dão unauthorized e a conexão segue aberta para os canais públicos", async () => {
      const client = await open();
      expect(await client.ask({ type: "subscribe", channel: "me" })).toMatchObject({
        type: "error",
        data: { code: "unauthorized", channel: "me" },
      });
      expect(await client.ask({ type: "subscribe", channel: "admin" })).toMatchObject({
        data: { code: "unauthorized", channel: "admin" },
      });
      expect(await client.ask({ type: "subscribe", channel: "prices" })).toMatchObject({ type: "subscribed" });
    });

    it("C8: jogador em admin dá forbidden", async () => {
      const client = await open();
      await client.ask({ type: "auth", token: "tok-ana" });
      expect(await client.ask({ type: "subscribe", channel: "admin" })).toMatchObject({
        type: "error",
        data: { code: "forbidden", channel: "admin" },
      });
    });

    it.each(["inventado", "club:fla3", "club:", "club:FLA3:x", "club:FLAM3", "me:ana"])(
      "C8: o canal %j dá unknown_channel",
      async (channel) => {
        const client = await open();
        expect(await client.ask({ type: "subscribe", channel })).toMatchObject({
          type: "error",
          data: { code: "unknown_channel" },
        });
        expect(await client.ask({ type: "unsubscribe", channel })).toMatchObject({ data: { code: "unknown_channel" } });
      },
    );

    it("C10: admin assina admin e recebe", async () => {
      const client = await open();
      await client.ask({ type: "auth", token: "tok-adm" });
      expect(await client.ask({ type: "subscribe", channel: "admin" })).toMatchObject({ type: "subscribed" });
      bus.publish("admin", "admin.pending", { pendingMatches: 2 });
      expect(await client.next()).toMatchObject({ type: "admin.pending", channel: "admin", data: { pendingMatches: 2 } });
    });
  });

  describe("assinatura", () => {
    it("C15: quem não assinou o canal não recebe nada, e depois de unsubscribe nada mais chega", async () => {
      const client = await open();
      await client.ask({ type: "subscribe", channel: "club:FLA3" });
      bus.publish("club:PAL1", "trade", tradeData(90));
      expect(await client.quiet()).toBe(true);
      bus.publish("club:FLA3", "trade", tradeData(10));
      expect(await client.next()).toMatchObject({ type: "trade", data: { id: 10 } });
      client.send({ type: "unsubscribe", channel: "club:FLA3" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      bus.publish("club:FLA3", "trade", tradeData(11));
      expect(await client.quiet()).toBe(true);
    });

    it("C15: assinar o mesmo canal duas vezes não duplica a entrega", async () => {
      const client = await open();
      await client.ask({ type: "subscribe", channel: "club:SAN3" });
      await client.ask({ type: "subscribe", channel: "club:SAN3" });
      bus.publish("club:SAN3", "trade", tradeData(91));
      expect(await client.next()).toMatchObject({ type: "trade" });
      expect(await client.quiet()).toBe(true);
    });

    it("C16: reconexão com since reenvia só o que faltou, depois do subscribed, e segue ao vivo", async () => {
      for (let i = 1; i <= 4; i++) bus.publish("club:COR3", "trade", tradeData(i));
      const atual = bus.currentSeq("club:COR3");
      const client = await open();
      const reply = await client.ask({ type: "subscribe", channel: "club:COR3", since: atual - 2 });
      expect(reply).toMatchObject({ type: "subscribed", data: { seq: atual, mode: "resumed" } });
      expect(await client.next()).toMatchObject({ type: "trade", seq: atual - 1, data: { id: 3 } });
      expect(await client.next()).toMatchObject({ type: "trade", seq: atual, data: { id: 4 } });
      bus.publish("club:COR3", "trade", tradeData(5));
      expect(await client.next()).toMatchObject({ type: "trade", seq: atual + 1 });
      expect(await client.quiet()).toBe(true);
    });

    it("C17: since impossível (maior que o atual) dá resync e não reenvia nada", async () => {
      bus.publish("club:VAS3", "trade", tradeData(1));
      const client = await open();
      const reply = await client.ask({ type: "subscribe", channel: "club:VAS3", since: bus.currentSeq("club:VAS3") + 500 });
      expect(reply).toMatchObject({ type: "subscribed", data: { mode: "resync" } });
      expect(await client.quiet()).toBe(true);
    });
  });

  describe("mensagens ruins", () => {
    it("C3: JSON quebrado, tipo desconhecido, campo a mais e quadro binário dão bad_message e a conexão segue", async () => {
      const client = await open();
      expect(await client.ask("{quebrado")).toMatchObject({ type: "error", data: { code: "bad_message" } });
      expect(await client.ask({ type: "ping" })).toMatchObject({ data: { code: "bad_message" } });
      expect(await client.ask({ type: "subscribe", channel: "prices", x: 1 })).toMatchObject({
        data: { code: "bad_message" },
      });
      client.socket.send(Buffer.from([1, 2, 3]));
      expect(await client.next()).toMatchObject({ data: { code: "bad_message" } });
      expect(await client.ask({ type: "subscribe", channel: "prices" })).toMatchObject({ type: "subscribed" });
    });
  });

  describe("prazo", () => {
    it("C11: conexão sem mensagem válida no prazo fecha com 4408", async () => {
      const client = await open();
      expect(await client.closed).toMatchObject({ code: 4408 });
    });

    it("C11: mensagem quebrada não vale como mensagem válida", async () => {
      const client = await open();
      client.send("{quebrado");
      expect(await client.closed).toMatchObject({ code: 4408 });
    });

    it("C11: depois de uma mensagem válida a conexão fica aberta além do prazo", async () => {
      const client = await open();
      await client.ask({ type: "subscribe", channel: "prices" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(client.socket.readyState).toBe(client.socket.OPEN);
    });
  });
});
