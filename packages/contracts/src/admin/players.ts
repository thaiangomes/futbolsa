import { z } from "zod";
import { entriesQuerySchema, entriesResponseSchema } from "../portfolio/entries.js";
import { walletViewSchema } from "../portfolio/wallet.js";
import { myOrderSchema } from "../market/orders.js";
import { TICKER_PATTERN } from "../realtime/channels.js";
import { adminReasonSchema } from "./common.js";

/** Contratos de jogadores do admin (F14, T1): ver, bloquear, excluir e ajustar saldo. Tudo só em `/admin`. */

export const playerStatusSchema = z.enum(["active", "blocked", "deleted"]);
export const playerRoleSchema = z.enum(["player", "admin"]);

/** `GET /admin/players?q=&status=&role=&cursor=`: `q` é prefixo de apelido ou e-mail exato. */
export const playersQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(120).optional(),
  status: playerStatusSchema.optional(),
  role: playerRoleSchema.optional(),
  cursor: z.string().max(200).optional(),
});
export type PlayersQuery = z.infer<typeof playersQuerySchema>;

export const playerListItemSchema = z.strictObject({
  id: z.uuid(),
  nickname: z.string().nullable(),
  role: playerRoleSchema,
  status: playerStatusSchema,
  createdAt: z.string(),
  /** Patrimônio de agora, em centavos; vazio sem carteira na temporada. */
  equity: z.number().int().nullable(),
});
export type PlayerListItem = z.infer<typeof playerListItemSchema>;

export const playersListSchema = z.strictObject({
  items: z.array(playerListItemSchema),
  nextCursor: z.string().nullable(),
});
export type PlayersList = z.infer<typeof playersListSchema>;

export const playerAccountSchema = z.strictObject({
  id: z.uuid(),
  nickname: z.string().nullable(),
  /** O admin vê o e-mail (proposta 3 da F14); nunca no registro. */
  email: z.string().nullable(),
  role: playerRoleSchema,
  status: playerStatusSchema,
  blockedReason: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});

export const playerBidSchema = z.strictObject({
  ticker: z.string(),
  quantity: z.number().int(),
  maxPrice: z.number().int(),
  reserved: z.number().int(),
  status: z.enum(["active", "cancelled", "settled"]),
});

/** `GET /admin/players/:id`: conta, carteira da temporada atual, ordens abertas e ofertas do IPO. */
export const playerDetailSchema = z.strictObject({
  account: playerAccountSchema,
  /** Vazio sem carteira na temporada atual e na conta excluída. */
  wallet: walletViewSchema.nullable(),
  entryMode: z.enum(["ipo", "index", "cash"]).nullable(),
  openOrders: z.array(myOrderSchema),
  bids: z.array(playerBidSchema),
});
export type PlayerDetail = z.infer<typeof playerDetailSchema>;

export const playerEntriesQuerySchema = entriesQuerySchema;
export const playerEntriesResponseSchema = entriesResponseSchema;

/** `POST /admin/players/:id/block` e `/unblock`: motivo obrigatório nos dois (proposta 6). */
export const blockBodySchema = z.strictObject({ reason: adminReasonSchema });
export type BlockBody = z.infer<typeof blockBodySchema>;

export const blockResponseSchema = z.strictObject({
  status: playerStatusSchema,
  cancelledOrders: z.number().int(),
  cancelledBids: z.number().int(),
});
export type BlockResponse = z.infer<typeof blockResponseSchema>;

/** `DELETE /admin/players/:id`: o apelido atual digitado e o motivo. */
export const deletePlayerBodySchema = z.strictObject({
  confirmNickname: z.string().min(1).max(60),
  reason: adminReasonSchema,
});
export type DeletePlayerBody = z.infer<typeof deletePlayerBodySchema>;

export const deletePlayerResponseSchema = z.strictObject({
  walletCloseout: z.enum(["done", "after_ipo_settlement"]),
});
export type DeletePlayerResponse = z.infer<typeof deletePlayerResponseSchema>;

/** `POST /admin/players/:id/adjust` (com `Idempotency-Key`): `delta` inteiro e diferente de zero. */
export const adjustBodySchema = z
  .strictObject({
    asset: z.enum(["cash", "shares"]),
    ticker: z.string().regex(TICKER_PATTERN).optional(),
    delta: z
      .number()
      .int()
      .refine((n) => n !== 0, "O ajuste não pode ser zero.")
      .refine(Number.isSafeInteger, "Número grande demais."),
    reason: adminReasonSchema,
  })
  .refine((b) => (b.asset === "shares") === (b.ticker !== undefined), {
    message: "Ajuste de ações pede o clube; ajuste de caixa não tem clube.",
    path: ["ticker"],
  });
export type AdjustBody = z.infer<typeof adjustBodySchema>;

export const adjustResponseSchema = z.strictObject({
  asset: z.enum(["cash", "shares"]),
  ticker: z.string().nullable(),
  delta: z.number().int(),
  /** O preço exibido usado no custo, em centavos (só nas ações). */
  price: z.number().int().nullable(),
  /** O caixa total ou as ações do jogador depois do ajuste. */
  after: z.number().int(),
});
export type AdjustResponse = z.infer<typeof adjustResponseSchema>;
