import { z } from "zod";

/** Uma temporada encerrada no histórico do jogador (`GET /me/history`; Conta e login, critérios 15 a 17). */
export const historySeasonSchema = z.strictObject({
  year: z.number().int(),
  /** Patrimônio final e base, em centavos; o retorno é `(final − base) / base`, mostrado com duas casas. */
  finalEquity: z.number().int(),
  base: z.number().int(),
  /** Posição no ranking anual; `null` para quem não aparece (bloqueado). */
  position: z.number().int().nullable(),
  /** Posição em cada ranking mensal em que o jogador apareceu, em ordem de mês (`AAAA-MM`). */
  months: z.array(z.strictObject({ month: z.string(), position: z.number().int() })),
});
export type HistorySeason = z.infer<typeof historySeasonSchema>;

export const historyResponseSchema = z.strictObject({ seasons: z.array(historySeasonSchema) });
export type HistoryResponse = z.infer<typeof historyResponseSchema>;
