import { describe, expect, it } from "vitest";
import {
  CLOSE_CODES,
  EVENT_CATALOG,
  channelAcceptsEvent,
  channelKind,
  channelSchema,
  clubChannel,
  eventEnvelopeSchema,
  parseChannel,
  parseClientMessage,
  parseServerMessage,
  systemMessageSchema,
  type EventType,
} from "@futbolsa/contracts";

const AT = "2026-11-02T15:00:00.000Z";

describe("contratos do tempo real (T2)", () => {
  describe("canais", () => {
    it.each(["season", "prices", "rankings", "me", "admin", "club:FLA3", "club:PAL1"])(
      "C1: %s é canal válido",
      (channel) => {
        expect(parseChannel(channel)).toBe(channel);
        expect(channelSchema.safeParse(channel).success).toBe(true);
      },
    );

    it.each(["club:", "club:fla3", "club:FLA3:x", "club:FLA", "club:FLAM3", "outro", "", "Season", "me:1"])(
      "C1: %j é recusado",
      (channel) => {
        expect(parseChannel(channel)).toBeNull();
        expect(channelSchema.safeParse(channel).success).toBe(false);
      },
    );

    it("C1: o tipo do canal esconde o ticker", () => {
      expect(channelKind(clubChannel("FLA3"))).toBe("club");
      expect(channelKind("prices")).toBe("prices");
    });
  });

  describe("envelope", () => {
    const evento = { type: "trade", channel: "club:FLA3", seq: 7, at: AT, data: { id: "n1", price: 1250 } };

    it("C2: aceita seq inteiro positivo e at em UTC", () => {
      expect(eventEnvelopeSchema.safeParse(evento).success).toBe(true);
    });

    it.each([0, -1, 1.5, "7"])("C2: seq %j é recusado no evento do jogo", (seq) => {
      expect(eventEnvelopeSchema.safeParse({ ...evento, seq }).success).toBe(false);
    });

    it.each(["2026-11-02T12:00:00-03:00", "2026-11-02", "ontem"])("C2: at %j (fora de UTC) é recusado", (at) => {
      expect(eventEnvelopeSchema.safeParse({ ...evento, at }).success).toBe(false);
    });

    it("C2: evento sem data ou com campo a mais é recusado", () => {
      const { data: _data, ...semData } = evento;
      expect(eventEnvelopeSchema.safeParse(semData).success).toBe(false);
      expect(eventEnvelopeSchema.safeParse({ ...evento, extra: 1 }).success).toBe(false);
    });

    it("C2: mensagem do sistema tem channel system e seq 0", () => {
      const ok = { type: "auth.ok", channel: "system", seq: 0, at: AT, data: { role: "player" } };
      expect(systemMessageSchema.safeParse(ok).success).toBe(true);
      expect(systemMessageSchema.safeParse({ ...ok, seq: 1 }).success).toBe(false);
      expect(systemMessageSchema.safeParse({ ...ok, channel: "season" }).success).toBe(false);
    });

    it("C2: subscribed, error e heartbeat usam o mesmo envelope", () => {
      const base = { channel: "system", seq: 0, at: AT };
      expect(
        systemMessageSchema.safeParse({
          ...base,
          type: "subscribed",
          data: { channel: "club:FLA3", seq: 1_800_000_000_123, mode: "resumed" },
        }).success,
      ).toBe(true);
      expect(
        systemMessageSchema.safeParse({ ...base, type: "error", data: { code: "unauthorized", channel: "me" } }).success,
      ).toBe(true);
      expect(systemMessageSchema.safeParse({ ...base, type: "heartbeat", data: {} }).success).toBe(true);
      expect(
        systemMessageSchema.safeParse({ ...base, type: "error", data: { code: "inventado" } }).success,
      ).toBe(false);
    });

    it("C2: parseServerMessage lê evento e sistema, e devolve null para o resto", () => {
      expect(parseServerMessage(JSON.stringify(evento))?.type).toBe("trade");
      expect(
        parseServerMessage(JSON.stringify({ type: "heartbeat", channel: "system", seq: 0, at: AT, data: {} }))?.type,
      ).toBe("heartbeat");
      expect(parseServerMessage("{quebrado")).toBeNull();
      expect(parseServerMessage(JSON.stringify({ type: "trade" }))).toBeNull();
    });
  });

  describe("mensagens do cliente", () => {
    it("C3: auth, subscribe (com e sem since) e unsubscribe passam", () => {
      expect(parseClientMessage(JSON.stringify({ type: "auth", token: "abc" }))).toEqual({
        ok: true,
        message: { type: "auth", token: "abc" },
      });
      expect(parseClientMessage(JSON.stringify({ type: "subscribe", channel: "prices" })).ok).toBe(true);
      expect(parseClientMessage(JSON.stringify({ type: "subscribe", channel: "club:FLA3", since: 42 }))).toEqual({
        ok: true,
        message: { type: "subscribe", channel: "club:FLA3", since: 42 },
      });
      expect(parseClientMessage(JSON.stringify({ type: "unsubscribe", channel: "prices" })).ok).toBe(true);
    });

    it.each([
      ["JSON quebrado", "{type:"],
      ["não é objeto", "[1,2]"],
      ["tipo desconhecido", JSON.stringify({ type: "ping" })],
      ["sem tipo", JSON.stringify({ channel: "prices" })],
      ["auth sem token", JSON.stringify({ type: "auth" })],
      ["auth com token vazio", JSON.stringify({ type: "auth", token: "" })],
      ["campo a mais", JSON.stringify({ type: "subscribe", channel: "prices", extra: true })],
      ["subscribe sem canal", JSON.stringify({ type: "subscribe" })],
      ["since zero", JSON.stringify({ type: "subscribe", channel: "prices", since: 0 })],
      ["since fracionário", JSON.stringify({ type: "subscribe", channel: "prices", since: 1.5 })],
      ["since negativo", JSON.stringify({ type: "subscribe", channel: "prices", since: -3 })],
      ["since texto", JSON.stringify({ type: "subscribe", channel: "prices", since: "3" })],
    ])("C3: %s vira bad_message", (_nome, raw) => {
      expect(parseClientMessage(raw)).toEqual({ ok: false, code: "bad_message" });
    });

    it("C3: canal inventado passa como mensagem (vira unknown_channel no gateway, e não bad_message)", () => {
      expect(parseClientMessage(JSON.stringify({ type: "subscribe", channel: "inventado" })).ok).toBe(true);
    });
  });

  describe("catálogo de eventos", () => {
    it("C4: cada tipo de evento pertence ao tipo de canal certo", () => {
      expect(channelAcceptsEvent("club:FLA3", "trade")).toBe(true);
      expect(channelAcceptsEvent("club:FLA3", "book")).toBe(true);
      expect(channelAcceptsEvent("me", "wallet.changed")).toBe(true);
      expect(channelAcceptsEvent("rankings", "rankings.live")).toBe(true);
      expect(channelAcceptsEvent("prices", "price")).toBe(true);
      expect(channelAcceptsEvent("season", "season.status")).toBe(true);
      expect(channelAcceptsEvent("admin", "admin.pending")).toBe(true);
    });

    it("C4: publicar um tipo no canal errado, ou um tipo que não existe, é recusado", () => {
      expect(channelAcceptsEvent("prices", "trade")).toBe(false);
      expect(channelAcceptsEvent("club:FLA3", "wallet.changed")).toBe(false);
      expect(channelAcceptsEvent("me", "rankings.live")).toBe(false);
      expect(channelAcceptsEvent("season", "toString")).toBe(false);
      expect(channelAcceptsEvent("season", "inventado")).toBe(false);
    });

    it("C4: todos os eventos da arquitetura estão no catálogo", () => {
      const esperados: EventType[] = [
        "season.status", "market.suspended", "market.resumed", "price", "trade", "book", "match_mode", "candle",
        "order.updated", "wallet.changed", "entry.added", "payout.credited", "rankings.live", "admin.pending",
      ];
      expect(Object.keys(EVENT_CATALOG).sort()).toEqual([...esperados].sort());
    });
  });

  it("códigos de fechamento são os do plano", () => {
    expect(Object.values(CLOSE_CODES).sort()).toEqual([1001, 1008, 1009, 1013, 4401, 4402, 4403, 4408]);
  });
});
