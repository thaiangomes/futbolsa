import type { GameMarker } from "@futbolsa/contracts";

/** Um jogo do clube como o leitor entrega (só `SELECT`; o clube é o de quem pede o gráfico). */
export interface GameRow {
  kickoff: Date;
  status: string;
  competition: string;
  round: number | null;
  phase: string | null;
  homeClubId: number;
  awayClubId: number;
  homeGoals: number | null;
  awayGoals: number | null;
  advancedClubId: number | null;
  opponent: { ticker: string | null; name: string };
}

/**
 * Os marcadores de jogos (critérios 24, 25 e 42): entram os jogos `finished` e os `scheduled` com início já passado
 * ("em andamento", o mesmo predicado do modo de jogo, sem placar); adiado e cancelado ficam de fora (o adiado só aparece
 * na data em que foi disputado, porque então vira `finished`). V, E ou D pelo placar do clube; no mata-mata decidido nos
 * pênaltis o resultado é "E" e `advanced` diz se o clube passou ou foi eliminado.
 */
export function gameMarkers(clubId: number, games: readonly GameRow[], now: Date): GameMarker[] {
  const out: GameMarker[] = [];
  for (const g of games) {
    const live = g.status === "scheduled" && g.kickoff.getTime() <= now.getTime();
    if (g.status !== "finished" && !live) continue;
    const home = g.homeClubId === clubId;
    const scored = g.status === "finished" && g.homeGoals !== null && g.awayGoals !== null;
    const goalsFor = scored ? (home ? g.homeGoals : g.awayGoals) : null;
    const goalsAgainst = scored ? (home ? g.awayGoals : g.homeGoals) : null;
    out.push({
      at: g.kickoff.toISOString(),
      competition: g.competition,
      round: g.round,
      phase: g.phase,
      opponent: g.opponent,
      home,
      status: live ? "live" : "finished",
      goalsFor,
      goalsAgainst,
      result: goalsFor === null || goalsAgainst === null ? null : goalsFor > goalsAgainst ? "V" : goalsFor < goalsAgainst ? "D" : "E",
      advanced: g.status === "finished" && g.advancedClubId !== null ? g.advancedClubId === clubId : null,
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
