import { z } from "zod";

/**
 * `season.status`, no canal `season`: a temporada mudou de estado (o IPO abriu, fechou ou teve o
 * fechamento adiado). Traz as datas, para a tela do período de ofertas atualizar sem recarregar. As fases
 * seguintes (negociação, recompra, encerramento) publicam o mesmo evento com este esquema.
 */
export const seasonStatusEventSchema = z.strictObject({
  seasonId: z.number().int(),
  status: z.enum(["preparing", "ipo_open", "ipo_closed", "trading", "trading_ended", "closed"]),
  ipoClosesAt: z.string().nullable(),
  tradingOpensAt: z.string().nullable(),
});
export type SeasonStatusEvent = z.infer<typeof seasonStatusEventSchema>;

/**
 * `wallet.changed`, no canal `me` (só o dono): o caixa, o reservado e, quando o movimento mexeu num
 * clube, as ações dele. `version` é o id da última linha do extrato: o cliente ignora o que for mais
 * velho que o que já mostra.
 */
export const walletChangedEventSchema = z.strictObject({
  cash: z.number().int(),
  reserved: z.number().int(),
  club: z.strictObject({ ticker: z.string(), shares: z.number().int() }).nullable(),
  version: z.number().int(),
});
export type WalletChangedEvent = z.infer<typeof walletChangedEventSchema>;

/** `entry.added`, no canal `me`: uma linha nova do extrato da carteira. */
export const entryAddedEventSchema = z.strictObject({
  id: z.number().int(),
  at: z.string(),
  kind: z.string(),
  ticker: z.string().nullable(),
  cashDelta: z.number().int(),
  reservedCashDelta: z.number().int(),
  sharesDelta: z.number().int(),
  price: z.number().int().nullable(),
  cashAfter: z.number().int(),
});
export type EntryAddedEvent = z.infer<typeof entryAddedEventSchema>;
