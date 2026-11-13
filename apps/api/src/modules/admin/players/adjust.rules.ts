import type { Cents } from "@futbolsa/engine";
import type { SeasonStatus } from "../../../infra/db/schema/index.js";

/**
 * A regra do ajuste de saldo do admin (Admin, critérios 27 e 28; propostas 4 e 8 da F14), sem banco: recebe o estado já
 * travado e devolve os movimentos ou a recusa. O crédito de ações custa o **preço exibido** no momento do crédito
 * (decisão do Thaian em 2026-10-30); o caixa não passa pela tesouraria (proposta 4).
 */

export type AdjustRefusal =
  | "adjust_insufficient_cash"
  | "adjust_insufficient_shares"
  | "treasury_insufficient_shares"
  | "adjust_not_allowed";

export interface AdjustInput {
  asset: "cash" | "shares";
  /** Centavos no caixa; ações nas ações. Positivo credita, negativo debita. Inteiro e diferente de zero. */
  delta: number;
  seasonStatus: SeasonStatus;
  wallet: { cash: Cents; reservedCash: Cents };
  /** A posição do jogador no clube (ajuste de ações). */
  position: { shares: number; reservedShares: number } | null;
  /** A posição da tesouraria no clube; as reservadas são as cotações da casa. */
  treasuryPosition: { shares: number; reservedShares: number } | null;
  /** O preço exibido do clube (ajuste de ações). */
  price: Cents | null;
}

/** Um movimento a gravar. `owner` diz em qual das duas carteiras. */
export interface AdjustMovement {
  owner: "player" | "treasury";
  cashDelta?: Cents;
  sharesDelta?: number;
  costBasis?: "purchase" | "debit";
  price?: Cents;
}

export type AdjustPlan = { ok: true; movements: AdjustMovement[] } | { ok: false; code: AdjustRefusal };

/** Caixa de `ipo_open` a `trading_ended`; ações só em `trading` (proposta 8). */
const CASH_PHASES: readonly SeasonStatus[] = ["ipo_open", "ipo_closed", "trading", "trading_ended"];

export function adjustPlan(input: AdjustInput): AdjustPlan {
  const { delta } = input;
  if (input.asset === "cash") {
    if (!CASH_PHASES.includes(input.seasonStatus)) return { ok: false, code: "adjust_not_allowed" };
    // crédito sempre aceito (também para quem está negativo, que só diminui a dívida); débito só do caixa livre
    if (delta < 0 && -delta > input.wallet.cash - input.wallet.reservedCash) return { ok: false, code: "adjust_insufficient_cash" };
    return { ok: true, movements: [{ owner: "player", cashDelta: delta }] };
  }

  if (input.seasonStatus !== "trading") return { ok: false, code: "adjust_not_allowed" };
  if (input.price === null || input.price <= 0) return { ok: false, code: "adjust_not_allowed" };
  if (delta > 0) {
    const free = input.treasuryPosition ? input.treasuryPosition.shares - input.treasuryPosition.reservedShares : 0;
    if (delta > free) return { ok: false, code: "treasury_insufficient_shares" };
    return {
      ok: true,
      movements: [
        { owner: "player", sharesDelta: delta, costBasis: "purchase", price: input.price },
        { owner: "treasury", sharesDelta: -delta, costBasis: "debit" },
      ],
    };
  }
  const free = input.position ? input.position.shares - input.position.reservedShares : 0;
  if (-delta > free) return { ok: false, code: "adjust_insufficient_shares" };
  return {
    ok: true,
    movements: [
      { owner: "player", sharesDelta: delta, costBasis: "debit" },
      { owner: "treasury", sharesDelta: -delta, costBasis: "purchase", price: input.price },
    ],
  };
}
