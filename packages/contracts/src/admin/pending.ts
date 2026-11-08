import { z } from "zod";
import { competitionSchema } from "./common.js";

/** Um jogo que já devia ter terminado e continua sem placar (Admin, critério 5). */
export const pendingMatchSchema = z.strictObject({
  matchId: z.number().int(),
  competition: competitionSchema,
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  homeTicker: z.string().nullable(),
  homeName: z.string(),
  awayTicker: z.string().nullable(),
  awayName: z.string(),
  kickoff: z.string(),
  /** Fim previsto (início mais 2 horas, ou o horário que o admin preencheu). */
  expectedEnd: z.string(),
});

/** A rodada ou a fase que os jogos pendentes impedem de fechar. */
export const blockedUnitSchema = z.strictObject({
  competition: competitionSchema,
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  matchIds: z.array(z.number().int()),
});

export const pendingResponseSchema = z.strictObject({
  matches: z.array(pendingMatchSchema),
  blocked: z.array(blockedUnitSchema),
  /** Última importação por competição (o maior `fetchedAt` dos jogos); nulo se nunca importou. */
  lastImports: z.record(z.string(), z.string().nullable()),
});
export type PendingResponse = z.infer<typeof pendingResponseSchema>;
