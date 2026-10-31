import type { Cents } from "@futbolsa/engine";
import type { Movement } from "./movement.js";

export interface CostState {
  shares: number;
  cost: Cents;
  realized: Cents;
}

export interface CostChange {
  cost: Cents;
  realized: Cents;
  /** Resultado realizado deste movimento, para a linha do extrato (nulo se não houve). */
  entryRealized: Cents | null;
}

/**
 * Custo e resultado realizado do movimento, como na B3 (Carteira e gráficos). A
 * conta é do motor: a tarefa T8 do Plano do banco liga aqui `buy`, `sell`,
 * `creditShares` e `debitShares` de `src/engine/cost.ts`, da F3. Até lá, o custo
 * fica como está.
 */
export function applyCost(before: CostState, _movement: Movement): CostChange {
  return { cost: before.cost, realized: before.realized, entryRealized: null };
}
