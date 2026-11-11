import { z } from "zod";
import { publicTradeSchema } from "./book.js";
import { auctionStateSchema, orderCancelReasonSchema, orderSideSchema, orderStatusSchema, orderTypeSchema } from "./orders.js";

/**
 * Os esquemas do `data` dos eventos do mercado (F9). O catálogo (tipo → canal) é o da F6 em
 * `realtime/events.ts`; `book` e `price` levam o valor absoluto, então repetir um não faz mal. `wallet.changed`
 * e `season.status` já têm esquema desde a F8 (`ipo/events.ts`).
 */

/** `trade`, no canal `club:<ticker>`: sem comprador nem vendedor, com o `id` para descartar repetido. */
export const tradeEventSchema = publicTradeSchema;
export type TradeEvent = z.infer<typeof tradeEventSchema>;

/** `price`, no canal `prices`: o preço exibido, a variação do dia e o leilão (no máximo um por clube por segundo). */
export const priceEventSchema = z.strictObject({
  ticker: z.string(),
  price: z.number().int(),
  changeBp: z.number().int(),
  auction: auctionStateSchema.nullable(),
});
export type PriceEvent = z.infer<typeof priceEventSchema>;

/** `match_mode`, no canal `club:<ticker>`: o modo de jogo da casa ligou ou desligou. */
export const matchModeEventSchema = z.strictObject({ active: z.boolean() });
export type MatchModeEvent = z.infer<typeof matchModeEventSchema>;

/** `candle`, no canal `club:<ticker>`: o candle de 15 minutos ou do dia que o negócio atualizou. */
export const candleEventSchema = z.strictObject({
  interval: z.enum(["15m", "1d"]),
  start: z.string(),
  open: z.number().int(),
  high: z.number().int(),
  low: z.number().int(),
  close: z.number().int(),
  volume: z.number().int(),
});
export type CandleEvent = z.infer<typeof candleEventSchema>;

/** `order.updated`, no canal `me` (só o dono): a ordem executou em parte ou por inteiro, ou foi cancelada. */
export const orderUpdatedEventSchema = z.strictObject({
  id: z.number().int(),
  ticker: z.string(),
  side: orderSideSchema,
  type: orderTypeSchema,
  quantity: z.number().int(),
  filled: z.number().int(),
  limitPrice: z.number().int().nullable(),
  reservedCash: z.number().int(),
  status: orderStatusSchema,
  cancelReason: orderCancelReasonSchema.nullable(),
});
export type OrderUpdatedEvent = z.infer<typeof orderUpdatedEventSchema>;
