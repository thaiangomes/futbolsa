import { z } from "zod";

export const CHART_RANGES = ["today", "7d", "30d", "season"] as const;
export const chartRangeSchema = z.enum(CHART_RANGES);
export type ChartRange = z.infer<typeof chartRangeSchema>;

/** `?range=` das três rotas do gráfico do clube; o padrão é o dia. */
export const chartQuerySchema = z.strictObject({ range: chartRangeSchema.default("today") });
export type ChartQuery = z.infer<typeof chartQuerySchema>;

export const chartCandleSchema = z.strictObject({
  /** Início do período (ISO, UTC). */
  start: z.string(),
  open: z.number().int(),
  high: z.number().int(),
  low: z.number().int(),
  close: z.number().int(),
  volume: z.number().int(),
});
export type ChartCandle = z.infer<typeof chartCandleSchema>;

/** `GET /clubs/:ticker/candles`: público. Período sem negócio repete o fechamento; antes do primeiro vale o preço do IPO. */
export const candlesResponseSchema = z.strictObject({
  /** O `seq` do canal do clube, lido antes do banco. */
  seq: z.number().int(),
  range: chartRangeSchema,
  interval: z.enum(["15m", "1d"]),
  from: z.string(),
  to: z.string(),
  ipoPrice: z.number().int().nullable(),
  tradingOpensAt: z.string().nullable(),
  candles: z.array(chartCandleSchema),
});
export type CandlesResponse = z.infer<typeof candlesResponseSchema>;

export const gameMarkerSchema = z.strictObject({
  at: z.string(),
  competition: z.string(),
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  opponent: z.strictObject({ ticker: z.string().nullable(), name: z.string() }),
  home: z.boolean(),
  /** `live`: em andamento, sem placar. */
  status: z.enum(["finished", "live"]),
  goalsFor: z.number().int().nullable(),
  goalsAgainst: z.number().int().nullable(),
  result: z.enum(["V", "E", "D"]).nullable(),
  /** Mata-mata: o clube passou ou foi eliminado (nulo fora do mata-mata ou sem decisão). */
  advanced: z.boolean().nullable(),
});
export type GameMarker = z.infer<typeof gameMarkerSchema>;

export const payoutMarkerSchema = z.strictObject({
  at: z.string(),
  kind: z.enum(["payout", "reversal", "complement"]),
  reason: z.string(),
  /** Valor por ação (no estorno e no complemento, a diferença com sinal). */
  perShare: z.number().int(),
  /** `pending`: aguardando aprovação. */
  status: z.enum(["pending", "approved"]),
  buyback: z.boolean(),
});
export type PayoutMarker = z.infer<typeof payoutMarkerSchema>;

/** `GET /clubs/:ticker/markers`: público (jogos e dividendos). */
export const markersResponseSchema = z.strictObject({
  range: chartRangeSchema,
  games: z.array(gameMarkerSchema),
  payouts: z.array(payoutMarkerSchema),
});
export type MarkersResponse = z.infer<typeof markersResponseSchema>;

export const myTradeSchema = z.strictObject({
  at: z.string(),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int(),
  price: z.number().int(),
});
export type MyTrade = z.infer<typeof myTradeSchema>;

/** `GET /portfolio/clubs/:ticker/trades`: os meus negócios no clube e o meu preço médio (nulo sem ações). */
export const myTradesResponseSchema = z.strictObject({
  range: chartRangeSchema,
  trades: z.array(myTradeSchema),
  averagePrice: z.number().int().nullable(),
});
export type MyTradesResponse = z.infer<typeof myTradesResponseSchema>;
