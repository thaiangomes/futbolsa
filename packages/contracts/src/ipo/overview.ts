import { z } from "zod";
import { ipoCashSchema, myBidSchema } from "./bids.js";

/** A faixa de um clube, com a conta que a tela mostra: preço da colocação mais a parte das copas. */
export const ipoBandSchema = z.strictObject({
  floor: z.number().int(),
  center: z.number().int(),
  ceiling: z.number().int(),
  placementPrice: z.number().int(),
  cupsPart: z.number().int(),
});
export type IpoBandView = z.infer<typeof ipoBandSchema>;

export const ipoClubSchema = z.strictObject({
  ticker: z.string(),
  name: z.string(),
  band: ipoBandSchema,
  myBid: myBidSchema.nullable(),
});
export type IpoClubView = z.infer<typeof ipoClubSchema>;

/**
 * `GET /ipo`: o que o jogador vê do IPO. O esquema é estrito de propósito: nunca a demanda, o
 * número de ofertas nem as ofertas dos outros jogadores (IPO por bookbuilding, critério 15).
 * Antes da abertura só vêm as datas previstas, sem faixa e sem clubes. `cash` é nulo para quem
 * não tem carteira na temporada.
 */
export const ipoOverviewSchema = z.strictObject({
  status: z.enum(["preparing", "ipo_open", "ipo_closed", "trading", "trading_ended", "closed"]),
  offerSize: z.number().int().nullable(),
  opensAt: z.string().nullable(),
  closesAt: z.string().nullable(),
  tradingOpensAt: z.string().nullable(),
  clubs: z.array(ipoClubSchema),
  cash: ipoCashSchema.nullable(),
});
export type IpoOverview = z.infer<typeof ipoOverviewSchema>;
