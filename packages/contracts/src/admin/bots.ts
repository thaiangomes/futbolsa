import { z } from "zod";
import { adminReasonSchema } from "./common.js";

/** Bots ao vivo (F14, T1): quantos ativos por perfil. */
export const BOT_PROFILE_NAMES = [
  "dividendos",
  "momentum",
  "torcedor",
  "aleatorio",
  "trader",
  "captura",
  "analista",
  "concentrador",
  "antecipador",
] as const;
export const botProfileSchema = z.enum(BOT_PROFILE_NAMES);
export type BotProfileName = z.infer<typeof botProfileSchema>;

/** Limite proposto por perfil, sem medida (o teste de carga da F16 diz quantos a API aguenta). */
export const MAX_BOTS_PER_PROFILE = 200;

export const botItemSchema = z.strictObject({
  id: z.number().int(),
  active: z.boolean(),
  /** Patrimônio de agora; vazio se o bot ainda não tem carteira na temporada. */
  equity: z.number().int().nullable(),
  hasWallet: z.boolean(),
});

export const botProfileViewSchema = z.strictObject({
  profile: botProfileSchema,
  active: z.number().int(),
  inactive: z.number().int(),
  bots: z.array(botItemSchema),
});

/** `GET /admin/bots`. */
export const botsViewSchema = z.strictObject({
  profiles: z.array(botProfileViewSchema),
  botsInRankings: z.boolean(),
});
export type BotsView = z.infer<typeof botsViewSchema>;

/** `PATCH /admin/bots`: só os perfis que mudam, cada número de 0 a 200. */
export const patchBotsBodySchema = z
  .strictObject({
    counts: z.partialRecord(botProfileSchema, z.number().int().min(0).max(MAX_BOTS_PER_PROFILE)),
    reason: adminReasonSchema.optional(),
  })
  .refine((b) => Object.keys(b.counts).length > 0, { message: "Nada para mudar.", path: ["counts"] });
export type PatchBotsBody = z.infer<typeof patchBotsBodySchema>;

export const patchBotsResponseSchema = z.strictObject({
  turnedOn: z.array(z.number().int()),
  turnedOff: z.array(z.number().int()),
  created: z.array(z.number().int()),
});
export type PatchBotsResponse = z.infer<typeof patchBotsResponseSchema>;
