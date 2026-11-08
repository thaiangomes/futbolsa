import type { CompetitionCode, PendingResponse } from "@futbolsa/contracts";
import { COMPETITIONS } from "../../../infra/db/schema/values.js";

/** Quanto tempo depois do fim previsto um jogo sem placar vira pendência (Admin, critério 5). */
export const PENDING_AFTER_MS = 6 * 60 * 60 * 1000;

/** Início mais 2 horas, como o motor assume quando o admin não preencheu o fim (`finishTime`). */
const DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;

export interface PendingInput {
  id: number;
  competition: CompetitionCode;
  round: number | null;
  phase: string | null;
  homeTicker: string | null;
  homeName: string;
  awayTicker: string | null;
  awayName: string;
  kickoff: Date;
  finishedAt: Date | null;
  status: "scheduled" | "finished" | "postponed" | "cancelled";
  outOfWindow: boolean;
  homeGoals: number | null;
  /** `source_snapshot.fetchedAt`: quando a fonte foi consultada sobre este jogo. */
  fetchedAt: string | null;
}

/**
 * Os jogos que já deviam ter terminado (fim previsto há 6 horas ou mais) e continuam sem placar, e a
 * rodada ou fase que cada um impede de fechar. Jogo adiado, cancelado, fora da janela ou com placar não
 * conta: marcar como adiado tira o jogo da lista (critério 8). Mostra também a última importação por
 * competição, que sai do maior `fetchedAt` dos jogos.
 */
export function findPending(games: readonly PendingInput[], now: Date): PendingResponse {
  const result: PendingResponse = {
    matches: [],
    blocked: [],
    lastImports: Object.fromEntries(COMPETITIONS.map((c) => [c, null as string | null])),
  };
  for (const g of games) {
    if (g.fetchedAt && (result.lastImports[g.competition] === null || g.fetchedAt > result.lastImports[g.competition]!)) {
      result.lastImports[g.competition] = g.fetchedAt;
    }
    if (g.status !== "scheduled" || g.outOfWindow || g.homeGoals !== null) continue;
    const expectedEnd = g.finishedAt ?? new Date(g.kickoff.getTime() + DEFAULT_DURATION_MS);
    if (now.getTime() < expectedEnd.getTime() + PENDING_AFTER_MS) continue;
    result.matches.push({
      matchId: g.id,
      competition: g.competition,
      round: g.round,
      phase: g.phase,
      homeTicker: g.homeTicker,
      homeName: g.homeName,
      awayTicker: g.awayTicker,
      awayName: g.awayName,
      kickoff: g.kickoff.toISOString(),
      expectedEnd: expectedEnd.toISOString(),
    });
    const unit = result.blocked.find((b) => b.competition === g.competition && b.round === g.round && b.phase === g.phase);
    if (unit) unit.matchIds.push(g.id);
    else result.blocked.push({ competition: g.competition, round: g.round, phase: g.phase, matchIds: [g.id] });
  }
  return result;
}
