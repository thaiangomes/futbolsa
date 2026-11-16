import type { CompetitionMatch, CompetitionStage, CompetitionView } from "@futbolsa/contracts";

/** As abas da página, na ordem da tela. */
export const COMPETITION_TABS: readonly { id: CompetitionView["competition"]; label: string }[] = [
  { id: "brasileirao-a", label: "Série A" },
  { id: "brasileirao-b", label: "Série B" },
  { id: "copa-do-brasil", label: "Copa do Brasil" },
  { id: "libertadores", label: "Libertadores" },
  { id: "sulamericana", label: "Sul-Americana" },
];

export const isLeague = (competition: CompetitionView["competition"]): boolean => competition === "brasileirao-a" || competition === "brasileirao-b";

/** A aba pedida no endereço (`?c=copa-do-brasil`); sem ela, ou com uma desconhecida, a Série A. */
export function tabFromSearch(search: string): CompetitionView["competition"] {
  const c = new URLSearchParams(search).get("c");
  return COMPETITION_TABS.find((t) => t.id === c)?.id ?? "brasileirao-a";
}

/**
 * A rodada que a tela abre: a primeira que ainda tem jogo por acontecer (em jogo ou agendado); se todas acabaram, a última.
 * Devolve o índice na lista de rodadas.
 */
export function currentStageIndex(stages: readonly CompetitionStage[]): number {
  const open = stages.findIndex((s) => s.matches.some((m) => m.status === "scheduled"));
  return open >= 0 ? open : Math.max(0, stages.length - 1);
}

/** Como um jogo se decidiu: o placar, e nos pênaltis quando o placar empatou e alguém passou. */
export function decidedOnPenalties(m: Pick<CompetitionMatch, "status" | "homeGoals" | "awayGoals" | "advanced">): boolean {
  return m.status === "finished" && m.advanced !== null && m.homeGoals !== null && m.homeGoals === m.awayGoals;
}
