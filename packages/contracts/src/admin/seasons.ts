import { z } from "zod";
import { adminReasonSchema, clubRefSchema, cupCompetitionSchema, isoInstantSchema } from "./common.js";

export const seasonViewSchema = z.strictObject({
  id: z.number().int(),
  year: z.number().int(),
  status: z.enum(["preparing", "ipo_open", "ipo_closed", "trading", "trading_ended", "closed"]),
  offerSize: z.number().int().nullable(),
  firstKickoff: z.string().nullable(),
  ipoOpensAt: z.string().nullable(),
  ipoClosesAt: z.string().nullable(),
  tradingOpensAt: z.string().nullable(),
  suspendedReason: z.string().nullable(),
});
export type SeasonView = z.infer<typeof seasonViewSchema>;

/** `GET /season` (público): a temporada atual e os clubes suspensos, com o motivo. */
export const publicSeasonSchema = z.strictObject({
  season: seasonViewSchema.nullable(),
  suspendedClubs: z.array(z.strictObject({ ticker: z.string(), reason: z.string() })),
});
export type PublicSeason = z.infer<typeof publicSeasonSchema>;

export const createSeasonBodySchema = z.strictObject({ year: z.number().int().min(2025).max(2100) });

export const patchSeasonBodySchema = z
  .strictObject({
    offerSize: z.number().int().min(1).optional(),
    firstKickoff: isoInstantSchema.optional(),
    /** Novo fechamento do IPO, só para adiar com as ofertas abertas (F8; antecipar é recusado). */
    ipoClosesAt: isoInstantSchema.optional(),
    /** A chave dos bots nos rankings (F14): vale na hora; aceita em qualquer fase menos temporada encerrada. */
    botsInRankings: z.boolean().optional(),
    reason: adminReasonSchema.optional(),
  })
  .refine((b) => b.offerSize !== undefined || b.firstKickoff !== undefined || b.ipoClosesAt !== undefined || b.botsInRankings !== undefined, {
    message: "Nada para mudar.",
    path: ["(corpo)"],
  })
  // a chave dos bots tem a própria regra (vale em qualquer fase menos temporada encerrada): vai sozinha
  .refine((b) => b.botsInRankings === undefined || (b.offerSize === undefined && b.firstKickoff === undefined && b.ipoClosesAt === undefined), {
    message: "A chave dos bots nos rankings vai sozinha, sem outros campos.",
    path: ["botsInRankings"],
  });
export type PatchSeasonBody = z.infer<typeof patchSeasonBodySchema>;

/** Um clube listado na temporada. `prevPlacement` na ordem única de 1 a 24; vazio para o Clube dos Treze que segue na B. */
export const seasonClubInputSchema = z.strictObject({
  clubId: z.number().int(),
  division: z.enum(["A", "B"]),
  prevPlacement: z.number().int().min(1).max(24).nullable(),
});
export const putSeasonClubsBodySchema = z.strictObject({
  clubs: z.array(seasonClubInputSchema).min(20),
  reason: adminReasonSchema.optional(),
});
export type PutSeasonClubsBody = z.infer<typeof putSeasonClubsBodySchema>;

export const seasonClubsResponseSchema = z.strictObject({
  clubs: z.array(
    z.strictObject({
      club: clubRefSchema,
      division: z.enum(["A", "B"]),
      prevPlacement: z.number().int().nullable(),
    }),
  ),
});

/** `GET /admin/seasons/current`: a temporada atual e os clubes listados. */
export const currentSeasonResponseSchema = z.strictObject({
  season: seasonViewSchema.nullable(),
  clubs: seasonClubsResponseSchema.shape.clubs,
});
export type CurrentSeasonResponse = z.infer<typeof currentSeasonResponseSchema>;

/** Valores de dividendos das ligas (centavos por ação), como no `season_rules`. */
export const seasonRulesSchema = z.strictObject({
  aPerPoint: z.number().int().min(0),
  bPerPoint: z.number().int().min(0),
  /** Colocação final da Série A, do 1º ao último (centavos por ação). */
  aPlacement: z.array(z.number().int().min(0)).min(1).max(20),
  /** Classificação para o ano seguinte (centavos por ação): Libertadores e Sul-Americana; quem vai às duas recebe só a primeira. */
  aLibertadoresBonus: z.number().int().min(0),
  aSulamericanaBonus: z.number().int().min(0),
  /** Rebaixamento: centavos por ação debitados dos rebaixados no fechamento, e quantos últimos colocados pagam. */
  aRelegationPenalty: z.number().int().min(0),
  aRelegationSlots: z.number().int().min(0).max(20),
  promotionPerShare: z.number().int().min(0),
  promotionSlots: z.number().int().min(0),
  buybackMultipleBp: z.number().int().min(0),
  lockedAt: z.string().nullable(),
});
export type SeasonRulesView = z.infer<typeof seasonRulesSchema>;
/** Os campos de classificação e rebaixamento são opcionais no corpo: omitidos, ficam como estão. */
export const putSeasonRulesBodySchema = seasonRulesSchema
  .omit({ lockedAt: true })
  .partial({ aLibertadoresBonus: true, aSulamericanaBonus: true, aRelegationPenalty: true, aRelegationSlots: true })
  .extend({ reason: adminReasonSchema.optional() });
export type PutSeasonRulesBody = z.infer<typeof putSeasonRulesBodySchema>;

/** Uma fase que paga na copa: `advance`, `to:<fase>` ou `title`. */
export const cupPhaseSchema = z.strictObject({
  phaseKey: z.string().trim().min(1).max(40),
  variant: z.string().regex(/^(advance|title|to:.+)$/),
  perShare: z.number().int().min(0),
});
export const putCupBodySchema = z.strictObject({
  phases: z.array(cupPhaseSchema).min(1),
  reason: adminReasonSchema.optional(),
});
export type PutCupBody = z.infer<typeof putCupBodySchema>;

/**
 * A correção da tabela de uma copa no meio da temporada (item 16 da fila da partida de teste): a tabela inteira, com as fases que
 * faltavam, e o motivo (obrigatório, porque vai para o registro do admin). As fases que já têm pagamento ficam como estão.
 */
export const correctCupBodySchema = z.strictObject({
  phases: z.array(cupPhaseSchema).min(1),
  reason: adminReasonSchema,
});
export type CorrectCupBody = z.infer<typeof correctCupBodySchema>;

/** Aviso de `validateCupTable`: a tabela quebra uma regra, mas é aceita (decisão do Thaian em 2026-10-31). */
export const cupViolationSchema = z.strictObject({ code: z.string(), message: z.string() });

export const cupViewSchema = z.strictObject({
  competition: cupCompetitionSchema,
  phases: z.array(cupPhaseSchema),
  violations: z.array(cupViolationSchema),
  /** Fases dos jogos que ainda não têm valor na tabela. */
  phasesWithoutValue: z.array(z.string()),
  confirmedBy: z.string().nullable(),
  confirmedAt: z.string().nullable(),
});
export type CupView = z.infer<typeof cupViewSchema>;

/** `GET /admin/seasons/:id/rules`: os valores das ligas e a tabela de cada copa, com os avisos. */
export const seasonRulesResponseSchema = z.strictObject({
  rules: seasonRulesSchema,
  cups: z.array(cupViewSchema),
});
export type SeasonRulesResponse = z.infer<typeof seasonRulesResponseSchema>;

/** `GET /admin/clubs`: os clubes com ticker, para escolher a lista da temporada. */
export const knownClubsResponseSchema = z.strictObject({ clubs: z.array(clubRefSchema) });
export type KnownClubsResponse = z.infer<typeof knownClubsResponseSchema>;
