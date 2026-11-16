/** O que a conta precisa de um jogo de copa: quem jogou, em que fase, se acabou e quem passou. */
export interface CupMatch {
  phase: string | null;
  status: string;
  homeClubId: number;
  awayClubId: number;
  /** Mata-mata: quem passou (inclusive nos pênaltis). Nulo na fase de grupos e antes do jogo. */
  advancedClubId: number | null;
  /** O placar, quando o jogo acabou (a decisão sem `advancedClubId` vale por ele). */
  homeGoals?: number | null;
  awayGoals?: number | null;
  kickoff: Date;
}

/**
 * Onde um clube está numa copa agora (T12, "fase atual de cada copa"):
 * - `undefined`: o clube não disputa a copa nesta temporada (nenhum jogo dele);
 * - `null`: já caiu, ou a copa acabou para ele (não ganha mais nada dela);
 * - uma fase: a mais antiga em que ele ainda tem jogo por disputar ou, se todos os jogos dele acabaram, a seguinte à última em que passou.
 *
 * `matches` são todos os jogos da copa na temporada, de todos os clubes: saber se a fase seguinte já tem jogos ajuda a
 * dizer se quem não aparece nela caiu (fase de grupos não diz quem passou, só a fase seguinte diz).
 */
export function cupPhaseOf(matches: readonly CupMatch[], clubId: number, phases: readonly string[]): string | null | undefined {
  const mine = matches.filter(
    (m) => m.status !== "cancelled" && m.phase !== null && phases.includes(m.phase) && (m.homeClubId === clubId || m.awayClubId === clubId),
  );
  if (mine.length === 0) return undefined;

  const index = (m: CupMatch) => phases.indexOf(m.phase!);
  // A fonte já lista jogos de fases futuras (chaveamento montado antes de a fase de grupos acabar): a fase atual é a mais
  // antiga em que ele ainda tem jogo por disputar, não a mais adiantada em que aparece.
  const open = mine.filter((m) => m.status !== "finished");
  if (open.length > 0) return phases[Math.min(...open.map(index))]!;

  const latest = Math.max(...mine.map(index));
  const here = mine.filter((m) => index(m) === latest);
  const phase = phases[latest]!;
  // todos os jogos dele nesta fase acabaram
  if (latest === phases.length - 1) return null; // a final acabou: campeão ou vice, não há mais nada a receber
  const decided = [...here].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime()).map((m) => m.advancedClubId).filter((id) => id !== null);
  const advancedId = decided[decided.length - 1];
  if (advancedId === clubId) return phases[latest + 1] ?? null;
  if (advancedId !== undefined) return null; // outro passou
  // a fonte não diz quem passou (fase de grupos): se a fase seguinte já tem jogos e ele não está neles, caiu
  const laterStarted = matches.some((m) => m.status !== "cancelled" && m.phase !== null && phases.includes(m.phase) && phases.indexOf(m.phase) > latest);
  return laterStarted ? null : phase;
}

export type CupOutcome = "playing" | "eliminated" | "champion";

/**
 * A situação do clube numa copa: `playing` (ainda disputa), `champion` (ganhou a final) ou `eliminated` (saiu antes ou perdeu
 * a final); `undefined` quando ele não disputa a copa. A final vale por `advancedClubId` e, sem ele, pelo placar.
 */
export function cupOutcomeOf(matches: readonly CupMatch[], clubId: number, phases: readonly string[]): CupOutcome | undefined {
  const phase = cupPhaseOf(matches, clubId, phases);
  if (phase === undefined) return undefined;
  if (phase !== null) return "playing";
  const finalPhase = phases[phases.length - 1];
  const won = matches.some((m) => {
    if (m.phase !== finalPhase || m.status !== "finished" || (m.homeClubId !== clubId && m.awayClubId !== clubId)) return false;
    if (m.advancedClubId !== null) return m.advancedClubId === clubId;
    if (m.homeGoals == null || m.awayGoals == null || m.homeGoals === m.awayGoals) return false;
    return (m.homeGoals > m.awayGoals ? m.homeClubId : m.awayClubId) === clubId;
  });
  return won ? "champion" : "eliminated";
}
