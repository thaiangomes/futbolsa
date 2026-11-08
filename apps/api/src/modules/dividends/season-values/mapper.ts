import type { CupRules, LeagueRules } from "@futbolsa/engine";

/** Uma linha de `cup_phases` sem a temporada e a copa. `ord` é a ordem da fase na copa. */
export interface CupPhaseRow {
  phaseKey: string;
  /** `advance`, `title` ou `to:<fase>` (o valor de quem foi para uma fase específica). */
  variant: string;
  ord: number;
  perShare: number;
}

/**
 * As regras de uma copa do motor (`CupRules`) como linhas de `cup_phases`: o valor de avançar de cada fase
 * (`advance`), os caminhos para uma fase específica (`to:<fase>`, como o 2º do grupo da Sul-Americana) e o
 * título, que fica na última fase.
 */
export function cupToRows(rules: CupRules): CupPhaseRow[] {
  const ord = (phase: string) => rules.phases.indexOf(phase);
  const rows: CupPhaseRow[] = [];
  for (const [phase, perShare] of Object.entries(rules.advance)) {
    rows.push({ phaseKey: phase, variant: "advance", ord: ord(phase), perShare });
  }
  for (const [from, destinations] of Object.entries(rules.advanceTo ?? {})) {
    for (const [to, perShare] of Object.entries(destinations)) {
      rows.push({ phaseKey: from, variant: `to:${to}`, ord: ord(from), perShare });
    }
  }
  const last = rules.phases.length - 1;
  rows.push({ phaseKey: rules.phases[last]!, variant: "title", ord: last, perShare: rules.title });
  return rows.sort((a, b) => a.ord - b.ord || a.variant.localeCompare(b.variant));
}

/** O caminho de volta: as linhas de uma copa viram as regras que o motor lê. */
export function cupFromRows(rows: readonly CupPhaseRow[]): CupRules {
  const phases = [...new Map([...rows].sort((a, b) => a.ord - b.ord).map((r) => [r.phaseKey, r.ord])).keys()];
  const advance: Record<string, number> = {};
  const advanceTo: Record<string, Record<string, number>> = {};
  let title = 0;
  for (const row of rows) {
    if (row.variant === "advance") advance[row.phaseKey] = row.perShare;
    else if (row.variant === "title") title = row.perShare;
    else if (row.variant.startsWith("to:")) {
      (advanceTo[row.phaseKey] ??= {})[row.variant.slice(3)] = row.perShare;
    }
  }
  const rules: CupRules = { phases, advance, title };
  if (Object.keys(advanceTo).length > 0) rules.advanceTo = advanceTo;
  return rules;
}

/** Os campos de `season_rules` que o admin edita (sem o `locked_at`). */
export interface RulesRow {
  aPerPoint: number;
  bPerPoint: number;
  aPlacement: number[];
  promotionPerShare: number;
  promotionSlots: number;
  buybackMultipleBp: number;
}

/** As duas ligas do motor a partir de `season_rules`: a Série B paga o acesso igual aos que sobem. */
export function leaguesFromRules(rules: RulesRow): { "brasileirao-a": LeagueRules; "brasileirao-b": LeagueRules } {
  return {
    "brasileirao-a": { perPoint: rules.aPerPoint, placement: [...rules.aPlacement] },
    "brasileirao-b": { perPoint: rules.bPerPoint, placement: Array.from({ length: rules.promotionSlots }, () => rules.promotionPerShare) },
  };
}
