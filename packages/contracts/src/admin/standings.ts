import { z } from "zod";
import { adminReasonSchema, clubRefSchema } from "./common.js";

export const standingsCompetitionSchema = z.enum(["brasileirao-a", "brasileirao-b"]);
export type StandingsCompetition = z.infer<typeof standingsCompetitionSchema>;

export const standingsRowSchema = z.strictObject({
  club: clubRefSchema,
  position: z.number().int(),
  points: z.number().int(),
  /** A posição que a fonte traz (para a tela mostrar a diferença quando o admin corrigiu). */
  sourcePosition: z.number().int().nullable(),
});

export const standingsViewSchema = z.strictObject({
  competition: standingsCompetitionSchema,
  rows: z.array(standingsRowSchema),
  manualOverride: z.boolean(),
  /** Nulo até o admin conferir; cai quando a importação muda a tabela sem correção manual. */
  confirmedBy: z.string().nullable(),
  confirmedAt: z.string().nullable(),
});
export type StandingsView = z.infer<typeof standingsViewSchema>;

export const standingsResponseSchema = z.strictObject({ standings: z.array(standingsViewSchema) });
export type StandingsResponse = z.infer<typeof standingsResponseSchema>;

/** `PATCH /admin/standings/:competition`: a ordem completa dos clubes, do 1º ao último. */
export const patchStandingsBodySchema = z.strictObject({
  order: z.array(z.number().int()).min(2),
  reason: adminReasonSchema,
});
export type PatchStandingsBody = z.infer<typeof patchStandingsBodySchema>;
