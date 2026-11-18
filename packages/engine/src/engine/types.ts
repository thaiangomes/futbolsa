/** Formato dos dados de partidas usados pelo motor (ver data/README.md). */

export type MatchStatus = "finished" | "scheduled" | "cancelled";

export interface Match {
  id: string;
  /** Ex.: "brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores". */
  competition: string;
  /** Rodada (pontos corridos). */
  round?: number;
  /** Fase (copas), ex.: "oitavas". */
  phase?: string;
  /** Início da partida em ISO 8601 com fuso, ex.: "2025-03-29T18:30:00-03:00". */
  kickoff: string;
  /** Fim da partida; se ausente, assume início + 2 horas. */
  finishedAt?: string;
  home: string;
  away: string;
  homeGoals: number | null;
  awayGoals: number | null;
  status: MatchStatus;
  /**
   * Jogo disputado fora da janela da sua rodada (adiado ou antecipado). Os
   * pontos dele pagam no fechamento da primeira rodada que terminar depois dele.
   */
  postponed?: boolean;
  /** Copas: clube que avançou/venceu no jogo que decide o confronto. */
  winner?: string;
  /**
   * Placar de um jogo em andamento quando os dados foram baixados (partida de teste, item 23). O jogo continua "agendado" e
   * sem placar: só os bots da partida leem isto; nada de dividendo ou classificação.
   */
  parcial?: { homeGoals: number; awayGoals: number };
}

export interface Club {
  /** Ticker, ex.: "FLA3". */
  id: string;
  name: string;
  /** Divisão nesta temporada. */
  division: "A" | "B";
}

export const MATCH_DURATION_MS = 2 * 60 * 60 * 1000;

export function kickoffTime(m: Match): number {
  return Date.parse(m.kickoff);
}

export function finishTime(m: Match): number {
  return m.finishedAt ? Date.parse(m.finishedAt) : kickoffTime(m) + MATCH_DURATION_MS;
}
