import { BRASILEIRAO_A, BRASILEIRAO_B, COPA_DO_BRASIL, type CupRules, LIBERTADORES, SULAMERICANA } from "@futbolsa/engine";
import type { RulesRow } from "./mapper.js";

export type CupCompetition = "copa-do-brasil" | "libertadores" | "sulamericana";

/** O múltiplo da recompra: 1,5 vez o que a ação pagou na temporada, em pontos-base (Dividendos e recompra). */
export const DEFAULT_BUYBACK_MULTIPLE_BP = 15_000;

/** Valores da primeira temporada: as constantes do motor (`BRASILEIRAO_A`, `BRASILEIRAO_B` e as copas de 2025). */
export function initialRules(): RulesRow {
  return {
    aPerPoint: BRASILEIRAO_A.perPoint,
    bPerPoint: BRASILEIRAO_B.perPoint,
    aPlacement: [...BRASILEIRAO_A.placement],
    aLibertadoresBonus: BRASILEIRAO_A.qualification?.libertadores ?? 0,
    aSulamericanaBonus: BRASILEIRAO_A.qualification?.sulamericana ?? 0,
    aRelegationPenalty: BRASILEIRAO_A.penalty?.[19] ?? 0,
    aRelegationSlots: BRASILEIRAO_A.penalty?.filter((p) => p > 0).length ?? 0,
    promotionPerShare: BRASILEIRAO_B.placement[0] ?? 0,
    promotionSlots: BRASILEIRAO_B.placement.length,
    buybackMultipleBp: DEFAULT_BUYBACK_MULTIPLE_BP,
  };
}

export const INITIAL_CUPS: Record<CupCompetition, CupRules> = {
  "copa-do-brasil": COPA_DO_BRASIL,
  libertadores: LIBERTADORES,
  sulamericana: SULAMERICANA,
};
