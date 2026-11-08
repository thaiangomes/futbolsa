import { z } from "zod";

/** O que o jogador recebeu de um clube no rateio. */
export const myAllocationSchema = z.strictObject({
  shares: z.number().int(),
  paid: z.number().int(),
  refunded: z.number().int(),
});
export type MyAllocation = z.infer<typeof myAllocationSchema>;

export const ipoClubResultSchema = z.strictObject({
  ticker: z.string(),
  name: z.string(),
  cutPrice: z.number().int(),
  /** Demanda total, em ações, no preço de corte (já é público depois da liquidação). */
  demandAtCut: z.number().int(),
  /** Fração do rateio: oferta ÷ demanda, ou 1 ÷ 1 sem rateio. */
  ratio: z.strictObject({ num: z.number().int(), den: z.number().int() }),
  /** Ações da oferta que ninguém comprou e foram para a tesouraria. */
  leftoverShares: z.number().int(),
  /** Lote do formador, emitido para a tesouraria sem pagamento. */
  lotShares: z.number().int(),
  myAllocation: myAllocationSchema.nullable(),
});
export type IpoClubResult = z.infer<typeof ipoClubResultSchema>;

/**
 * `GET /ipo/results`: `pending` enquanto o período de ofertas não fechou, `settling` enquanto
 * falta liquidar algum clube e, só com todos liquidados, o resultado de cada um (IPO por
 * bookbuilding, critério 24).
 */
export const ipoResultsSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("settling") }),
  z.strictObject({ status: z.literal("settled"), clubs: z.array(ipoClubResultSchema) }),
]);
export type IpoResults = z.infer<typeof ipoResultsSchema>;
