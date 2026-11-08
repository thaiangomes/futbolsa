import { z } from "zod";
import { competitionSchema } from "./common.js";

export const importKindSchema = z.enum(["calendar", "scores", "standings"]);
export type ImportKind = z.infer<typeof importKindSchema>;

/** `POST /admin/imports/run`: importar na hora. Sem competição, importa todas. */
export const runImportBodySchema = z.strictObject({
  competition: competitionSchema.optional(),
  kind: importKindSchema.optional(),
});
export type RunImportBody = z.infer<typeof runImportBodySchema>;

export const importReportSchema = z.strictObject({
  competition: competitionSchema,
  kind: importKindSchema,
  inserted: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  /** Clubes que a importação criou sem ticker (podem ser duplicados de outro nome). */
  clubsCreated: z.array(z.string()),
  error: z.string().nullable(),
});
export const runImportResponseSchema = z.strictObject({ reports: z.array(importReportSchema) });
export type RunImportResponse = z.infer<typeof runImportResponseSchema>;
