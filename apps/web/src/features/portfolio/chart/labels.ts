import type { ChartRange, GameMarker, PayoutMarker } from "@futbolsa/contracts";

export const RANGE_LABELS: Record<ChartRange, string> = { today: "Hoje", "7d": "7 dias", "30d": "30 dias", season: "Temporada" };

const COMPETITIONS: Record<string, string> = {
  "brasileirao-a": "Brasileirão",
  "brasileirao-b": "Brasileirão Série B",
  "copa-do-brasil": "Copa do Brasil",
  libertadores: "Libertadores",
  sulamericana: "Sul-Americana",
};

const PHASES: Record<string, string> = {
  "1a-fase": "1ª fase",
  "2a-fase": "2ª fase",
  "3a-fase": "3ª fase",
  grupos: "fase de grupos",
  "fase-de-grupos": "fase de grupos",
  oitavas: "oitavas de final",
  quartas: "quartas de final",
  semifinal: "semifinal",
  final: "final",
};

export function competitionLabel(competition: string): string {
  return COMPETITIONS[competition] ?? competition;
}

export function phaseLabel(phase: string): string {
  return PHASES[phase] ?? phase.replace(/-/g, " ");
}

/** `Brasileirão, rodada 5` ou `Copa do Brasil, oitavas de final`. */
export function gameContext(game: Pick<GameMarker, "competition" | "round" | "phase">): string {
  const name = competitionLabel(game.competition);
  if (game.round !== null) return `${name}, rodada ${game.round}`;
  if (game.phase) return `${name}, ${phaseLabel(game.phase)}`;
  return name;
}

/** O nome do adversário na lista: o ticker quando listado, senão o nome. */
export function opponentLabel(game: Pick<GameMarker, "opponent">): string {
  return game.opponent.ticker ?? game.opponent.name;
}

/** `FLA3 2 × 1 PAL3` (o clube sempre à esquerda), ou `FLA3 × PAL3` sem placar. */
export function scoreLine(ticker: string, game: GameMarker): string {
  const other = opponentLabel(game);
  const left = game.home ? ticker : other;
  const right = game.home ? other : ticker;
  if (game.goalsFor === null || game.goalsAgainst === null) return `${left} × ${right}`;
  const home = game.home ? game.goalsFor : game.goalsAgainst;
  const away = game.home ? game.goalsAgainst : game.goalsFor;
  return `${left} ${home} × ${away} ${right}`;
}

/** O resultado do clube em texto, com o desfecho do mata-mata (`E · classificou-se`). */
export function resultText(game: GameMarker): string {
  if (game.status === "live") return "em andamento";
  const base = game.result ?? "";
  if (game.advanced === true) return `${base} · classificou-se`;
  if (game.advanced === false) return `${base} · eliminado`;
  return base;
}

export function payoutKindLabel(p: Pick<PayoutMarker, "kind" | "buyback">): string {
  if (p.kind === "reversal") return "Estorno de dividendo";
  if (p.kind === "complement") return "Complemento de dividendo";
  return p.buyback ? "Recompra" : "Dividendo";
}
