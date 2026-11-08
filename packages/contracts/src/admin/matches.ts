import { z } from "zod";
import { adminReasonSchema, clubRefSchema, competitionSchema, isoInstantSchema, matchStatusSchema } from "./common.js";

/** O que a fonte disse por último sobre o jogo, para a tela mostrar a divergência. */
export const sourceViewSchema = z.strictObject({
  status: matchStatusSchema,
  homeGoals: z.number().int().nullable(),
  awayGoals: z.number().int().nullable(),
  kickoff: z.string(),
  fetchedAt: z.string(),
});

export const adminMatchSchema = z.strictObject({
  id: z.number().int(),
  seasonId: z.number().int(),
  competition: competitionSchema,
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  home: clubRefSchema,
  away: clubRefSchema,
  kickoff: z.string(),
  finishedAt: z.string().nullable(),
  homeGoals: z.number().int().nullable(),
  awayGoals: z.number().int().nullable(),
  advancedClubId: z.number().int().nullable(),
  status: matchStatusSchema,
  outOfWindow: z.boolean(),
  source: z.string().nullable(),
  manualOverride: z.boolean(),
  /** O que a fonte diz, quando o jogo foi editado à mão. */
  sourceView: sourceViewSchema.nullable(),
  /** O placar, o estado ou o horário do admin diferem do que a fonte traz. */
  diverges: z.boolean(),
});
export type AdminMatch = z.infer<typeof adminMatchSchema>;

export const listMatchesQuerySchema = z.strictObject({
  competition: competitionSchema.optional(),
  round: z.coerce.number().int().min(1).optional(),
  phase: z.string().min(1).max(40).optional(),
  status: matchStatusSchema.optional(),
  /** Só os editados à mão que divergem da fonte. */
  diverging: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ListMatchesQuery = z.infer<typeof listMatchesQuerySchema>;

export const listMatchesResponseSchema = z.strictObject({ matches: z.array(adminMatchSchema) });

const goalsSchema = z.number().int().min(0).max(99);

/** `POST /admin/matches`: jogo que a fonte não trouxe. Rodada ou fase, uma das duas. */
export const createMatchBodySchema = z
  .strictObject({
    competition: competitionSchema,
    round: z.number().int().min(1).optional(),
    phase: z.string().trim().min(1).max(40).optional(),
    homeClubId: z.number().int(),
    awayClubId: z.number().int(),
    kickoff: isoInstantSchema,
    finishedAt: isoInstantSchema.optional(),
    status: matchStatusSchema.default("scheduled"),
    homeGoals: goalsSchema.optional(),
    awayGoals: goalsSchema.optional(),
    advancedClubId: z.number().int().optional(),
    reason: adminReasonSchema,
  })
  .refine((b) => (b.round === undefined) !== (b.phase === undefined), {
    message: "Informe a rodada (pontos corridos) ou a fase (copa), não os dois.",
    path: ["round"],
  })
  .refine((b) => b.homeClubId !== b.awayClubId, { message: "Os dois clubes são o mesmo.", path: ["awayClubId"] });
export type CreateMatchBody = z.infer<typeof createMatchBodySchema>;

/** `PATCH /admin/matches/:id`: só o que mudou. Marcar adiado é `status: "postponed"`; desmarcar, `"scheduled"`. */
export const patchMatchBodySchema = z
  .strictObject({
    kickoff: isoInstantSchema.optional(),
    finishedAt: isoInstantSchema.nullable().optional(),
    status: matchStatusSchema.optional(),
    homeGoals: goalsSchema.nullable().optional(),
    awayGoals: goalsSchema.nullable().optional(),
    advancedClubId: z.number().int().nullable().optional(),
    reason: adminReasonSchema,
  })
  .refine((b) => Object.keys(b).some((k) => k !== "reason"), { message: "Nada para mudar.", path: ["(corpo)"] });
export type PatchMatchBody = z.infer<typeof patchMatchBodySchema>;
