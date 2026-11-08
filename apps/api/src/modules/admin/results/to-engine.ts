import type { Match as EngineMatch } from "@futbolsa/engine";
import type { matches } from "../../../infra/db/schema/index.js";

export type MatchRow = typeof matches.$inferSelect;

/**
 * Uma linha de `matches` no formato do motor. O motor entende o adiado como um booleano: adiado = o
 * estado é `postponed` **ou** o jogo está fora da janela da rodada. O admin que desmarca um adiado
 * zera as duas colunas, e a linha passa a ter `manual_override`, então a importação não o marca de novo.
 * `tickerOf` dá o id do clube no motor (o ticker, ou `EXT-<id>` para o clube não listado).
 */
export function toEngineMatch(row: MatchRow, tickerOf: (clubId: number) => string): EngineMatch {
  const match: EngineMatch = {
    id: String(row.id),
    competition: row.competition,
    kickoff: row.kickoff.toISOString(),
    home: tickerOf(row.homeClubId),
    away: tickerOf(row.awayClubId),
    homeGoals: row.homeGoals,
    awayGoals: row.awayGoals,
    status: row.status === "finished" ? "finished" : row.status === "cancelled" ? "cancelled" : "scheduled",
  };
  if (row.round !== null) match.round = row.round;
  if (row.phase !== null) match.phase = row.phase;
  if (row.finishedAt) match.finishedAt = row.finishedAt.toISOString();
  if (row.status === "postponed" || row.outOfWindow) match.postponed = true;
  if (row.advancedClubId !== null) match.winner = tickerOf(row.advancedClubId);
  return match;
}
