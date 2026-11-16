import { z } from "zod";
import { FIXTURE_COMPETITIONS } from "./fixtures.js";

/**
 * A página das competições (item 11 da fila da partida de teste): `GET /competitions/:competition`. Pública. A classificação
 * e os jogos de uma competição da temporada, com dados que o calendário já mostra a todos: nada da casa.
 */

export const competitionParamSchema = z.enum(FIXTURE_COMPETITIONS);

/** Um clube do jogo ou da tabela: o ticker quando é listado na temporada (para o selo e o link), e sempre o nome. */
export const competitionClubSchema = z.strictObject({ ticker: z.string().nullable(), name: z.string() });

export const standingRowSchema = z.strictObject({
  position: z.number().int(),
  club: competitionClubSchema,
  /** Os pontos da classificação oficial. */
  points: z.number().int(),
  /** Jogos, vitórias, empates, derrotas e saldo de gols, contados dos jogos encerrados que a temporada tem. */
  played: z.number().int(),
  wins: z.number().int(),
  draws: z.number().int(),
  losses: z.number().int(),
  goalDiff: z.number().int(),
});
export type StandingRow = z.infer<typeof standingRowSchema>;

export const competitionMatchSchema = z.strictObject({
  kickoff: z.string(),
  status: z.enum(["scheduled", "finished", "postponed", "cancelled"]),
  home: competitionClubSchema,
  away: competitionClubSchema,
  homeGoals: z.number().int().nullable(),
  awayGoals: z.number().int().nullable(),
  /** Mata-mata: quem passou. Com o placar empatado, passou nos pênaltis. */
  advanced: z.enum(["home", "away"]).nullable(),
  /** O jogo já começou e o placar ainda não chegou. */
  inPlay: z.boolean(),
});
export type CompetitionMatch = z.infer<typeof competitionMatchSchema>;

/** Uma rodada (campeonatos) ou uma fase (copas), com os jogos do mais cedo ao mais tarde. */
export const competitionStageSchema = z.strictObject({
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  matches: z.array(competitionMatchSchema),
});
export type CompetitionStage = z.infer<typeof competitionStageSchema>;

export const competitionViewSchema = z.strictObject({
  competition: competitionParamSchema,
  /** A classificação: só nos campeonatos; nas copas, vazia. */
  standings: z.array(standingRowSchema),
  stages: z.array(competitionStageSchema),
});
export type CompetitionView = z.infer<typeof competitionViewSchema>;
