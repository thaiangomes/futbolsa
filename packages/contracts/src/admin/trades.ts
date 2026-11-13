import { z } from "zod";
import { TICKER_PATTERN } from "../realtime/channels.js";
import { isoInstantSchema } from "./common.js";

/** Auditoria de negócios do admin (F14, T1): a contraparte só existe aqui, nunca fora do `/admin`. */

/** `GET /admin/trades?player=&pair=&club=&from=&to=&season=&cursor=`. `pair` são dois ids de conta separados por vírgula. */
export const auditQuerySchema = z.strictObject({
  player: z.string().trim().min(1).max(80).optional(),
  pair: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v.split(",").length === 2 && v.split(",").every((p) => p.trim().length > 0), "Informe duas contas separadas por vírgula.")
    .optional(),
  club: z.string().regex(TICKER_PATTERN).optional(),
  from: isoInstantSchema.optional(),
  to: isoInstantSchema.optional(),
  season: z.coerce.number().int().min(1).optional(),
  cursor: z.string().max(100).optional(),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Um lado do negócio: jogador (apelido), bot, a casa ou conta excluída. */
export const tradePartySchema = z.strictObject({
  kind: z.enum(["player", "bot", "house", "deleted"]),
  id: z.string().nullable(),
  label: z.string(),
});
export type TradeParty = z.infer<typeof tradePartySchema>;

export const auditTradeSchema = z.strictObject({
  id: z.number().int(),
  at: z.string(),
  ticker: z.string(),
  quantity: z.number().int(),
  price: z.number().int(),
  value: z.number().int(),
  inAuction: z.boolean(),
  buyer: tradePartySchema,
  seller: tradePartySchema,
});
export type AuditTrade = z.infer<typeof auditTradeSchema>;

export const auditResponseSchema = z.strictObject({
  trades: z.array(auditTradeSchema),
  nextCursor: z.string().nullable(),
});
export type AuditResponse = z.infer<typeof auditResponseSchema>;
