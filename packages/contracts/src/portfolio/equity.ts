import { z } from "zod";

/** `GET /portfolio/equity`: o patrimônio dia a dia (às 24h de Brasília) e o valor atual. */
export const equityResponseSchema = z.strictObject({
  base: z.number().int(),
  /** O instante de entrada na temporada (o primeiro ponto do gráfico). */
  startedAt: z.string(),
  points: z.array(z.strictObject({ day: z.string(), equity: z.number().int() })),
  current: z.strictObject({ at: z.string(), equity: z.number().int() }),
  /** Dias de Brasília com dividendo creditado, com o total do dia. */
  dividendDays: z.array(z.strictObject({ day: z.string(), total: z.number().int() })),
});
export type EquityResponse = z.infer<typeof equityResponseSchema>;
