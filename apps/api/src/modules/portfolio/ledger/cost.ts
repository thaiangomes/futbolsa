import { buy, debitShares, sell, type Cents, type CostPosition } from "@futbolsa/engine";
import { LedgerError } from "./errors.js";
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
 * conta é do motor (`src/engine/cost.ts`, da F3); aqui só se escolhe a função pela
 * origem do custo:
 * - `purchase` (ações entrando): `buy`, no negócio, no IPO, na carteira índice e no
 *   crédito do admin, que chega com o preço exibido (`creditShares` é o mesmo `buy`);
 * - `sale` (saindo): `sell`, na venda e na recompra, com resultado realizado;
 * - `debit` (saindo): `debitShares`, no débito do admin, sem resultado.
 * Na anulação de negócio (`trade_annulled`, proposta 18 do Plano do admin de jogadores e bots) não há conta
 * aqui: o custo e o resultado vêm prontos no movimento (`annulled`, de `replayCost`), mesmo sem ações de volta,
 * e o resultado da linha é o quanto o realizado mudou.
 * O `post` já conferiu que a posição não fica negativa.
 */
export function applyCost(before: CostState, m: Movement): CostChange {
  if (m.kind === "trade_annulled") {
    // o `validate` já exigiu o `annulled` na anulação
    const { cost, realized } = m.annulled!;
    const change = realized - before.realized;
    return { cost, realized, entryRealized: change === 0 ? null : change };
  }
  const quantity = m.sharesDelta ?? 0;
  if (quantity === 0) return { cost: before.cost, realized: before.realized, entryRealized: null };
  const position: CostPosition = { shares: before.shares, cost: before.cost, realized: before.realized, dividends: 0 };
  if (quantity > 0) {
    if (m.costBasis !== "purchase") {
      throw new LedgerError("cost_basis_mismatch", `ações entrando pedem a origem purchase, recebido ${m.costBasis}`);
    }
    const after = buy(position, quantity, m.price!);
    return { cost: after.cost, realized: after.realized, entryRealized: null };
  }
  if (m.costBasis === "sale") {
    const { position: after, realized } = sell(position, -quantity, m.price!);
    return { cost: after.cost, realized: after.realized, entryRealized: realized };
  }
  if (m.costBasis === "debit") {
    const after = debitShares(position, -quantity);
    return { cost: after.cost, realized: after.realized, entryRealized: null };
  }
  throw new LedgerError("cost_basis_mismatch", `ações saindo pedem a origem sale ou debit, recebido ${m.costBasis}`);
}
