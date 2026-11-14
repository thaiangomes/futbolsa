export type LedgerErrorCode =
  | "wallet_not_locked"
  | "wallet_not_found"
  | "invalid_cents"
  | "invalid_quantity"
  | "club_required"
  | "cost_basis_required"
  | "cost_basis_mismatch"
  | "price_required"
  | "reason_required"
  /** `trade_annulled` sem o custo e o resultado prontos (`annulled`). */
  | "annulled_required"
  /** `annulled` num movimento que não é `trade_annulled`. */
  | "annulled_not_allowed"
  /** `trade_annulled` sem o negócio no `ref`. */
  | "trade_ref_required"
  | "negative_cash"
  | "negative_reserved_cash"
  | "reserved_exceeds_cash"
  | "negative_shares"
  | "negative_reserved_shares"
  | "reserved_exceeds_shares"
  | "negative_open_orders"
  /** `postMany` com movimentos de mais de uma carteira, ou `postCashEach` com uma carteira repetida (erro de programação). */
  | "wallet_mismatch"
  /** `postCashEach` com movimento de clube ou de ações (erro de programação). */
  | "cash_only";

/** Movimento recusado pelo `portfolio.post`. Regra, não falha do banco: não é repetido. */
export class LedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}
