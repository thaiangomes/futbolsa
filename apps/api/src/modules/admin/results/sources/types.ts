import type { CompetitionCode } from "@futbolsa/contracts";

/** Estado do jogo como o banco guarda (`matches.status`). */
export type SourceStatus = "scheduled" | "finished" | "postponed" | "cancelled";

/**
 * Um jogo como a fonte o traz, já convertido para o vocabulário do jogo. Os clubes vêm pelo
 * nome que a fonte usa: quem os transforma em `clubs` é o `resolveClub`.
 */
export interface SourceMatch {
  /** `espn` ou `football-data`: com `sourceId`, identifica o jogo (`matches_source_key`). */
  source: string;
  sourceId: string;
  competition: CompetitionCode;
  /** Pontos corridos. */
  round: number | null;
  /** Copas, com os nomes do motor (`1a-fase`, `oitavas`, `grupos`...). */
  phase: string | null;
  /** Início da partida. */
  kickoff: Date;
  status: SourceStatus;
  homeName: string;
  awayName: string;
  /** Só com o jogo encerrado. */
  homeGoals: number | null;
  awayGoals: number | null;
  /** Mata-mata: quem passou, quando a fonte diz. */
  advancedName: string | null;
}

/** Uma linha da classificação oficial, como a fonte a traz. */
export interface SourceStanding {
  clubName: string;
  position: number;
  points: number;
}

/** Intervalo de datas (inclusive nas duas pontas) para buscar só alguns dias. */
export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Uma fonte de resultados. A chamada à fonte acontece sempre fora de qualquer transação do
 * banco; quem grava é o `ImportService`. A fonte de cada competição vem de configuração
 * (`RESULT_SOURCES`): quem pagar um plano maior muda a configuração, não o código.
 */
export interface ResultSource {
  readonly id: string;
  fetchMatches(competition: CompetitionCode, year: number, range?: DateRange): Promise<SourceMatch[]>;
  fetchStandings(competition: CompetitionCode, year: number): Promise<SourceStanding[]>;
}
