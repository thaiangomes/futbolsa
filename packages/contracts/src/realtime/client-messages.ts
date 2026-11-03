import { z } from "zod";

/** `auth` só vale como primeira mensagem; o token nunca vai na URL. */
export const authMessageSchema = z.strictObject({
  type: z.literal("auth"),
  token: z.string().min(1),
});

/**
 * O canal é texto aqui, e não `channelSchema`: um canal inventado não é mensagem quebrada,
 * é `unknown_channel`, e a conexão segue aberta.
 */
export const subscribeMessageSchema = z.strictObject({
  type: z.literal("subscribe"),
  channel: z.string().min(1).max(64),
  since: z.number().int().positive().optional(),
});

export const unsubscribeMessageSchema = z.strictObject({
  type: z.literal("unsubscribe"),
  channel: z.string().min(1).max(64),
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  authMessageSchema,
  subscribeMessageSchema,
  unsubscribeMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ParsedClientMessage = { ok: true; message: ClientMessage } | { ok: false; code: "bad_message" };

/** Lê um quadro do cliente (texto JSON). JSON quebrado, tipo desconhecido e campo a mais ou a menos viram `bad_message`. */
export function parseClientMessage(raw: string): ParsedClientMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: "bad_message" };
  }
  const parsed = clientMessageSchema.safeParse(json);
  return parsed.success ? { ok: true, message: parsed.data } : { ok: false, code: "bad_message" };
}
