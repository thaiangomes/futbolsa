import { z } from "zod";
import { clubTickerParamSchema } from "../market/orders.js";
import { CLUB_VALUE_CUPS } from "./club-value.js";

/**
 * As projeções do jogador por clube (Livro de ofertas e formador de mercado, critérios 54 a 56): as premissas do
 * simulador "Quanto vale para você" (pontos, colocação e a fase em que o clube cai em cada copa), não um preço, para o
 * valor se refazer conforme os dividendos saem. Privadas: só o dono lê e grava (`GET /me/projections`,
 * `PUT /me/projections/:ticker`); nem a casa nem os bots as usam.
 */

/** O Brasileirão tem 38 rodadas de 3 pontos; as duas séries têm 20 clubes. */
export const PROJECTION_MAX_POINTS = 114;
export const PROJECTION_POSITIONS = 20;

export const projectionBodySchema = z.strictObject({
  points: z.number().int().min(0).max(PROJECTION_MAX_POINTS),
  position: z.number().int().min(1).max(PROJECTION_POSITIONS),
  /** Por copa, a fase em que o clube cai (ou `campeao`). */
  cups: z.partialRecord(z.enum(CLUB_VALUE_CUPS), z.string().min(1).max(40)),
});
export type ProjectionBody = z.infer<typeof projectionBodySchema>;

export const projectionSchema = projectionBodySchema.extend({
  ticker: clubTickerParamSchema,
  updatedAt: z.string(),
});
export type Projection = z.infer<typeof projectionSchema>;

export const projectionListSchema = z.strictObject({ projections: z.array(projectionSchema) });
export type ProjectionList = z.infer<typeof projectionListSchema>;
