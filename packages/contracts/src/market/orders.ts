import { z } from "zod";
import { TICKER_PATTERN } from "../realtime/channels.js";

/**
 * Contratos das ordens (F9: `POST /orders`, `DELETE /orders/:id`, `GET /orders`). Preços em centavos
 * inteiros e instantes em ISO 8601. Nada aqui carrega carteira, dono ou contraparte.
 */

export const orderSideSchema = z.enum(["buy", "sell"]);
export const orderTypeSchema = z.enum(["limit", "market"]);
export const orderStatusSchema = z.enum(["open", "filled", "cancelled"]);
/** Por que o jogo cancelou a ordem (os mesmos valores de `orders.cancel_reason`). */
export const orderCancelReasonSchema = z.enum([
  "player",
  "blocked",
  "deleted",
  "bot_off",
  "reversal",
  "trading_end",
  "house_refresh",
  "suspension",
  "market_remainder",
  "annulment",
]);

/**
 * Os motivos de recusa de uma ordem nova: os do motor (`RejectCode` de `validateOrder`) mais os quatro que só o
 * banco e o relógio sabem. Um teste da API confere que a lista é exatamente essa; a boleta tem uma mensagem
 * para cada um.
 */
export const ORDER_REJECT_CODES = [
  // do motor
  "invalid_quantity",
  "invalid_price",
  "below_min_price",
  "negative_cash",
  "price_out_of_band",
  "too_many_open_orders",
  "insufficient_cash",
  "insufficient_shares",
  "self_trade",
  "club_in_auction",
  // do banco e do relógio
  "account_blocked",
  "bot_inactive",
  "email_not_confirmed",
  "club_suspended",
  "market_closed",
] as const;
export type OrderRejectCode = (typeof ORDER_REJECT_CODES)[number];

/** Mensagens que o jogador vê, por código (as de recusa e as do cancelamento e da chave de idempotência). */
export const MARKET_ERROR_MESSAGES = {
  invalid_quantity: "A quantidade tem de ser um número inteiro de ações, de 1 em diante.",
  invalid_price: "O preço tem de ser um valor em reais com no máximo dois decimais, maior que zero.",
  below_min_price: "O preço mínimo de uma ação é R$ 0,50.",
  negative_cash: "Seu caixa está negativo: você só pode vender até regularizar.",
  price_out_of_band: "O preço está fora da faixa aceita agora: 20% acima ou abaixo do preço exibido.",
  too_many_open_orders: "Você já tem 50 ordens abertas. Cancele alguma para mandar outra.",
  insufficient_cash: "Seu caixa livre não cobre esta compra.",
  insufficient_shares: "Você não tem ações livres suficientes deste clube para esta venda.",
  self_trade: "Esta ordem cruzaria com uma ordem sua neste clube. Cancele a outra ou mude o preço.",
  club_in_auction: "Este clube está em leilão: use ordem limitada.",
  account_blocked: "Sua conta está bloqueada e não pode mandar ordens.",
  bot_inactive: "Este bot está desligado e não manda ordens.",
  email_not_confirmed: "Confirme seu e-mail para mandar ordens.",
  club_suspended: "A negociação deste clube está suspensa.",
  market_closed: "A negociação não está aberta.",
  order_not_found: "Ordem não encontrada.",
  order_not_open: "Esta ordem já foi executada ou cancelada.",
  idempotency_conflict: "Esta chave de envio já foi usada com outra ordem.",
} as const satisfies Record<OrderRejectCode | "order_not_found" | "order_not_open" | "idempotency_conflict", string>;

export type MarketErrorCode = keyof typeof MARKET_ERROR_MESSAGES;

/** O ticker na rota (`/clubs/:ticker/book`). */
export const clubTickerParamSchema = z.string().regex(TICKER_PATTERN);

/**
 * `POST /orders`. O esquema só pede números, como o do IPO: quem confere inteiros, centavos, mínimo e faixa é o
 * `validateOrder` do motor (o mesmo que a boleta roda no navegador), que devolve o código certo (livro 14).
 * `limitPrice` em centavos; a ordem a mercado não leva preço.
 */
export const placeOrderBodySchema = z.discriminatedUnion("type", [
  z.strictObject({
    ticker: z.string().regex(TICKER_PATTERN),
    side: orderSideSchema,
    type: z.literal("limit"),
    quantity: z.number(),
    limitPrice: z.number(),
  }),
  z.strictObject({
    ticker: z.string().regex(TICKER_PATTERN),
    side: orderSideSchema,
    type: z.literal("market"),
    quantity: z.number(),
  }),
]);
export type PlaceOrderBody = z.infer<typeof placeOrderBodySchema>;

/** Uma ordem do próprio jogador. Sem carteira. */
export const myOrderSchema = z.strictObject({
  id: z.number().int(),
  ticker: z.string(),
  side: orderSideSchema,
  type: orderTypeSchema,
  quantity: z.number().int(),
  filled: z.number().int(),
  limitPrice: z.number().int().nullable(),
  /** Caixa preso pela compra limitada aberta: quantidade que falta × preço limite. */
  reservedCash: z.number().int(),
  status: orderStatusSchema,
  cancelReason: orderCancelReasonSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MyOrder = z.infer<typeof myOrderSchema>;

/** O estado do leilão do clube: `until` vazio enquanto está parado pela suspensão (P11). Nulo fora de leilão. */
export const auctionStateSchema = z.strictObject({ until: z.string().nullable() });
export type AuctionState = z.infer<typeof auctionStateSchema>;

/** Um negócio da ordem que acabou de ser enviada: preço e quantidade, sem contraparte. */
export const orderFillSchema = z.strictObject({
  id: z.number().int(),
  at: z.string(),
  price: z.number().int(),
  quantity: z.number().int(),
});
export type OrderFill = z.infer<typeof orderFillSchema>;

/** O caixa da carteira, em centavos (o mesmo desenho do IPO). */
export const orderCashSchema = z.strictObject({
  total: z.number().int(),
  reserved: z.number().int(),
  free: z.number().int(),
});

export const placeOrderResponseSchema = z.strictObject({
  order: myOrderSchema,
  trades: z.array(orderFillSchema),
  /** A ordem abriu um leilão (a que sairia do túnel de preço): nada executou e ela entrou inteira nele. */
  openedAuction: z.boolean(),
  /** O estado do leilão do clube depois da ordem. */
  auction: auctionStateSchema.nullable(),
  cash: orderCashSchema,
});
export type PlaceOrderResponse = z.infer<typeof placeOrderResponseSchema>;

/** `DELETE /orders/:id`: a ordem cancelada e o caixa depois da devolução da reserva. */
export const cancelOrderResponseSchema = z.strictObject({
  order: myOrderSchema,
  cash: orderCashSchema,
});
export type CancelOrderResponse = z.infer<typeof cancelOrderResponseSchema>;

/** `GET /orders?status=open`: as ordens do próprio jogador. */
export const listOrdersQuerySchema = z.strictObject({ status: z.enum(["open"]).default("open") });
export const listOrdersResponseSchema = z.strictObject({ orders: z.array(myOrderSchema) });
export type ListOrdersResponse = z.infer<typeof listOrdersResponseSchema>;
