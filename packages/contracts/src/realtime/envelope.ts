import { z } from "zod";
import { channelSchema } from "./channels.js";

/** Canal das mensagens do sistema (`auth.ok`, `subscribed`...): o canal a que se referem vai no `data`. */
export const SYSTEM_CHANNEL = "system";

export const AUTH_ERROR_CODES = ["invalid_token", "no_account", "account_deleted"] as const;
export const ERROR_CODES = [
  "bad_message",
  "unauthorized",
  "forbidden",
  "unknown_channel",
  "too_many_subscriptions",
  "rate_limited",
  "auth_not_first",
] as const;
export const SUBSCRIBE_MODES = ["live", "resumed", "resync"] as const;
export const ROLES = ["visitor", "player", "admin"] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type SubscribeMode = (typeof SUBSCRIBE_MODES)[number];
export type RealtimeRole = (typeof ROLES)[number];

/** Instante em UTC (`2026-11-02T15:00:00.000Z`). */
const atSchema = z.iso.datetime();

/** Evento do jogo: `seq` inteiro de 1 em diante, por canal. */
export const eventEnvelopeSchema = z.strictObject({
  type: z.string().min(1),
  channel: channelSchema,
  seq: z.number().int().positive(),
  at: atSchema,
  data: z.json(),
});

function systemMessage<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({
    type: z.literal(type),
    channel: z.literal(SYSTEM_CHANNEL),
    seq: z.literal(0),
    at: atSchema,
    data,
  });
}

/** As mensagens do sistema, no mesmo envelope dos eventos (um formato só para o cliente ler). */
export const systemMessageSchema = z.discriminatedUnion("type", [
  systemMessage("auth.ok", z.strictObject({ role: z.enum(ROLES) })),
  systemMessage("auth.error", z.strictObject({ code: z.enum(AUTH_ERROR_CODES) })),
  systemMessage(
    "subscribed",
    z.strictObject({ channel: channelSchema, seq: z.number().int().nonnegative(), mode: z.enum(SUBSCRIBE_MODES) }),
  ),
  systemMessage("error", z.strictObject({ code: z.enum(ERROR_CODES), channel: z.string().max(64).optional() })),
  systemMessage("heartbeat", z.strictObject({})),
]);

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type SystemMessage = z.infer<typeof systemMessageSchema>;

/** Tudo o que o servidor manda: evento do jogo ou mensagem do sistema. */
export type ServerMessage = EventEnvelope | SystemMessage;

/** Lê um quadro do servidor (texto JSON). Devolve `null` se não for nenhum dos dois formatos. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const system = systemMessageSchema.safeParse(json);
  if (system.success) return system.data;
  const event = eventEnvelopeSchema.safeParse(json);
  return event.success ? event.data : null;
}
