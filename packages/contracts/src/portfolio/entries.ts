import { z } from "zod";
import { TICKER_PATTERN } from "../realtime/channels.js";
import { portfolioClubSchema } from "./wallet.js";

/** Os grupos de tipo do filtro do extrato. */
export const ENTRY_GROUPS = ["entry", "ipo", "trade", "dividend", "buyback", "adjustment", "other"] as const;
export const entryGroupSchema = z.enum(ENTRY_GROUPS);
export type EntryGroup = z.infer<typeof entryGroupSchema>;

/** `GET /portfolio/entries?club=&kind=&before=&limit=`. */
export const entriesQuerySchema = z.strictObject({
  club: z.string().regex(TICKER_PATTERN).optional(),
  kind: entryGroupSchema.optional(),
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type EntriesQuery = z.infer<typeof entriesQuerySchema>;

/** De onde vem a linha de dividendo: o evento de pagamento, o valor por ação e as ações da foto. */
export const entryPayoutSchema = z.strictObject({
  reason: z.string(),
  perShare: z.number().int(),
  shares: z.number().int(),
});

/** Uma linha do extrato. Nenhum campo traz a contraparte, a carteira de outro jogador ou "casa/bot". */
export const entryItemSchema = z.strictObject({
  id: z.number().int(),
  at: z.string(),
  kind: z.string(),
  group: entryGroupSchema,
  club: portfolioClubSchema.nullable(),
  /** Ações com sinal. */
  quantity: z.number().int(),
  price: z.number().int().nullable(),
  /** Caixa com sinal. */
  amount: z.number().int(),
  realized: z.number().int().nullable(),
  cashAfter: z.number().int(),
  reason: z.string().nullable(),
  payout: entryPayoutSchema.nullable(),
  /** O negócio saiu num leilão do túnel de preço. */
  inAuction: z.boolean(),
});
export type EntryItem = z.infer<typeof entryItemSchema>;

export const entriesResponseSchema = z.strictObject({
  items: z.array(entryItemSchema),
  nextCursor: z.string().nullable(),
});
export type EntriesResponse = z.infer<typeof entriesResponseSchema>;
