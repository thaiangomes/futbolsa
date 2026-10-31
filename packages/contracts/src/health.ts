import { z } from "zod";

/** Resposta de `GET /health`: a API está de pé e enxerga o motor (preço mínimo em centavos). */
export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  minPrice: z.number().int().positive(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
