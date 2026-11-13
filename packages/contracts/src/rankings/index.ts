import { z } from "zod";

/** Os dois rankings: o do mês (base no fechamento do mês anterior) e o da temporada (base R$ 100.000,00). */
export const RANKING_PERIODS = ["month", "season"] as const;
export const rankingPeriodSchema = z.enum(RANKING_PERIODS);
export type RankingPeriodName = z.infer<typeof rankingPeriodSchema>;

/** Erros das rotas de ranking. */
export const RANKING_ERROR_MESSAGES = {
  ranking_not_found: "Esse ranking ainda não foi fechado.",
  season_not_closed: "O ranking do ano só sai no encerramento da temporada. Veja a parcial.",
  invalid_period: "Período inválido.",
} as const;
export type RankingErrorCode = keyof typeof RANKING_ERROR_MESSAGES;

/** `yyyy-mm` e o ano de quatro dígitos. */
export const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const YEAR_KEY_PATTERN = /^\d{4}$/;

/** `?offset=&limit=` das páginas de ranking (até 100 linhas). */
export const rankingPageQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RankingPageQuery = z.infer<typeof rankingPageQuerySchema>;

/** `GET /rankings/live?period=month|season&offset=&limit=`. */
export const liveQuerySchema = rankingPageQuerySchema.extend({ period: rankingPeriodSchema.default("month") });
export type LiveQuery = z.infer<typeof liveQuerySchema>;

/**
 * Uma linha de ranking. Sem patrimônio nem base em R$ (só o retorno): cada jogador vê o próprio valor na carteira.
 * `walletKey` é opaco (não é o id da carteira). `returnBp` é nulo quando o jogador está sem base (patrimônio ≤ 0
 * no mês anterior).
 */
export const rankingRowSchema = z.strictObject({
  position: z.number().int().min(1),
  walletKey: z.string().min(1),
  /** Apelido atual; nulo se a conta foi excluída ("conta excluída") ou se é bot. */
  displayName: z.string().nullable(),
  isBot: z.boolean(),
  /** Rótulo do perfil, só para bot. */
  botLabel: z.string().nullable(),
  returnBp: z.number().int().nullable(),
});
export type RankingRow = z.infer<typeof rankingRowSchema>;

const pageFields = {
  botsIncluded: z.boolean(),
  total: z.number().int().min(0),
  offset: z.number().int().min(0),
  rows: z.array(rankingRowSchema).max(100),
};

/** `GET /rankings/month/:yyyy-mm` e `GET /rankings/season/:ano`: a versão atual do ranking oficial. */
export const officialRankingSchema = z.strictObject({
  period: rankingPeriodSchema,
  periodKey: z.string(),
  closedAt: z.string(),
  version: z.number().int().min(1),
  ...pageFields,
});
export type OfficialRanking = z.infer<typeof officialRankingSchema>;

/** `GET /rankings/live`: a parcial, com a linha de quem pediu (`me`, nulo sem login ou sem carteira). `seq` é o do canal `rankings`, lido antes do banco (P2 do Plano do WebSocket). */
export const liveRankingSchema = z.strictObject({
  period: rankingPeriodSchema,
  periodKey: z.string(),
  computedAt: z.string(),
  seq: z.number().int(),
  ...pageFields,
  me: rankingRowSchema.nullable(),
});
export type LiveRanking = z.infer<typeof liveRankingSchema>;

/** O evento `rankings.live`: só o topo 20, o total e a hora do cálculo. */
export const rankingsLiveEventSchema = z.strictObject({
  period: rankingPeriodSchema,
  periodKey: z.string(),
  computedAt: z.string(),
  total: z.number().int().min(0),
  top: z.array(rankingRowSchema).max(20),
});
export type RankingsLiveEvent = z.infer<typeof rankingsLiveEventSchema>;

/** Quem ganhou um ranking fechado (o 1º, com os empates). */
export const championSchema = z.strictObject({
  displayName: z.string().nullable(),
  isBot: z.boolean(),
  botLabel: z.string().nullable(),
  returnBp: z.number().int().nullable(),
});

/** `GET /rankings/history`: as temporadas com ranking oficial, os meses fechados e os campeões. */
export const rankingHistorySchema = z.strictObject({
  seasons: z.array(
    z.strictObject({
      year: z.number().int(),
      status: z.string(),
      months: z.array(
        z.strictObject({
          monthKey: z.string(),
          closedAt: z.string(),
          version: z.number().int().min(1),
          champions: z.array(championSchema),
        }),
      ),
      season: z
        .strictObject({ closedAt: z.string(), version: z.number().int().min(1), champions: z.array(championSchema) })
        .nullable(),
    }),
  ),
});
export type RankingHistory = z.infer<typeof rankingHistorySchema>;
