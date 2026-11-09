import { z } from "zod";

/** Motivo de uma ação do admin: de 3 a 500 caracteres, sem espaços nas pontas (Admin, critério 33). */
export const adminReasonSchema = z.string().trim().min(3).max(500);

/** Códigos das competições, os mesmos do banco (`matches.competition`). */
export const competitionSchema = z.enum(["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sulamericana"]);
export type CompetitionCode = z.infer<typeof competitionSchema>;

export const cupCompetitionSchema = z.enum(["copa-do-brasil", "libertadores", "sulamericana"]);
export type CupCompetitionCode = z.infer<typeof cupCompetitionSchema>;

export const matchStatusSchema = z.enum(["scheduled", "finished", "postponed", "cancelled"]);
export type MatchStatusCode = z.infer<typeof matchStatusSchema>;

/** Instante ISO 8601 com fuso, como `2027-04-01T13:00:00Z`. */
export const isoInstantSchema = z.iso.datetime({ offset: true });

/** Um clube nas respostas do admin (`ticker` vazio no clube não listado). */
export const clubRefSchema = z.strictObject({
  id: z.number().int(),
  ticker: z.string().nullable(),
  name: z.string(),
});
export type ClubRef = z.infer<typeof clubRefSchema>;

/** Erros das rotas do admin, com a mensagem que a tela mostra. */
export const ADMIN_ERROR_MESSAGES = {
  reason_required: "Explique o motivo: ele fica no registro do admin.",
  season_closed: "A temporada está encerrada: os resultados dela não aceitam mais correção.",
  ipo_opened: "O IPO já abriu: a oferta, a lista de clubes e as datas não mudam mais.",
  season_locked: "Os valores da temporada foram travados na abertura do IPO e não mudam mais.",
  already_suspended: "A negociação já está suspensa.",
  not_suspended: "A negociação não está suspensa.",
  club_not_listed: "Este clube não está listado na temporada.",
  no_season: "Não há temporada em preparação ou em andamento.",
  match_not_found: "Jogo não encontrado.",
  season_exists: "Já existe uma temporada em andamento: encerre a anterior antes de preparar outra.",
  cups_not_confirmed: "Confirme a tabela das três copas antes de abrir o IPO.",
  event_superseded: "Este pagamento mudou desde a prévia (um resultado foi corrigido): recarregue a prévia e aprove a versão nova.",
  standings_not_confirmed:
    "Confira a classificação oficial antes de aprovar a colocação ou o acesso: o valor depende da posição final.",
  payout_settling:
    "Um pagamento aprovado ainda está sendo creditado: espere terminar para a correção não ser calculada sobre um pagamento pela metade.",
  correction_stale: "Os resultados mudaram desde a prévia da correção: confira a prévia nova antes de aplicar.",
} as const;
export type AdminErrorCode = keyof typeof ADMIN_ERROR_MESSAGES;
