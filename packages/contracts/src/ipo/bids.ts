import { z } from "zod";
import { TICKER_PATTERN } from "../realtime/channels.js";

/** O ticker na rota (`/ipo/bids/:ticker`). */
export const tickerParamSchema = z.string().regex(TICKER_PATTERN);

/** Os números do caixa da carteira, em centavos. */
export const ipoCashSchema = z.strictObject({
  total: z.number().int(),
  reserved: z.number().int(),
  free: z.number().int(),
});
export type IpoCash = z.infer<typeof ipoCashSchema>;

/** A oferta do próprio jogador num clube. Nunca a dos outros. */
export const myBidSchema = z.strictObject({
  quantity: z.number().int(),
  /** Preço máximo pedido, em centavos (pode passar do teto; a reserva usa o teto). */
  maxPrice: z.number().int(),
  /** Reserva presa no caixa: quantidade × min(preço máximo, teto). */
  reserved: z.number().int(),
  updatedAt: z.string(),
});
export type MyBid = z.infer<typeof myBidSchema>;

/**
 * `PUT /ipo/bids/:ticker`: registra ou edita a oferta. `expect` diz qual é: `new` recusa com
 * `bid_exists` se já houver oferta (duas abas não se sobrescrevem), `existing` recusa com
 * `bid_not_found` se não houver. A quantidade e o preço são conferidos pelo motor, que devolve o
 * código certo (`invalid_quantity`, `invalid_price`), então o esquema só pede números.
 */
export const putBidBodySchema = z.strictObject({
  quantity: z.number(),
  maxPrice: z.number(),
  expect: z.enum(["new", "existing"]),
});
export type PutBidBody = z.infer<typeof putBidBodySchema>;

export const putBidResponseSchema = z.strictObject({
  ticker: z.string(),
  bid: myBidSchema,
  cash: ipoCashSchema,
});
export type PutBidResponse = z.infer<typeof putBidResponseSchema>;

/** `DELETE /ipo/bids/:ticker`: a reserva volta ao caixa livre. */
export const deleteBidResponseSchema = z.strictObject({
  ticker: z.string(),
  cash: ipoCashSchema,
});
export type DeleteBidResponse = z.infer<typeof deleteBidResponseSchema>;
