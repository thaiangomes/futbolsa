export type LedgerErrorCode =
  | "wallet_not_locked"
  | "wallet_not_found"
  | "invalid_cents"
  | "invalid_quantity"
  | "club_required"
  | "cost_basis_required"
  | "price_required"
  | "reason_required"
  | "negative_cash"
  | "negative_reserved_cash"
  | "reserved_exceeds_cash"
  | "negative_shares"
  | "negative_reserved_shares"
  | "reserved_exceeds_shares"
  | "negative_open_orders";

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
