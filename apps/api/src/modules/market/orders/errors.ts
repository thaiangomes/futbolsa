import { MARKET_ERROR_MESSAGES, type MarketErrorCode } from "@futbolsa/contracts";
import { DomainError } from "../../../infra/http/index.js";

/**
 * O status HTTP de cada recusa do mercado, no padrão das outras rotas: 422 para as regras da ordem (quantidade,
 * preço, faixa, caixa, ações, limite de ordens, ordem contra si mesmo, leilão), 403 para quem não pode negociar
 * (conta bloqueada, e-mail sem confirmar), 409 para o estado do jogo (negociação fechada, clube suspenso, ordem
 * que já não está aberta, chave de envio reaproveitada) e 404 para a ordem que não existe para quem pediu.
 */
const STATUS: Record<MarketErrorCode, number> = {
  invalid_quantity: 422,
  invalid_price: 422,
  below_min_price: 422,
  negative_cash: 422,
  price_out_of_band: 422,
  too_many_open_orders: 422,
  insufficient_cash: 422,
  insufficient_shares: 422,
  self_trade: 422,
  club_in_auction: 422,
  account_blocked: 403,
  bot_inactive: 409,
  email_not_confirmed: 403,
  club_suspended: 409,
  market_closed: 409,
  order_not_found: 404,
  order_not_open: 409,
  idempotency_conflict: 409,
};

/** O status HTTP de um código do mercado. */
export function marketErrorStatus(code: MarketErrorCode): number {
  return STATUS[code];
}

/**
 * A mensagem que o jogador vê. Na suspensão (do clube ou do mercado todo), o motivo que o admin escreveu vai junto:
 * todos veem por que a negociação parou (Admin, critério 23).
 */
export function marketErrorMessage(code: MarketErrorCode, reason?: string): string {
  const base = MARKET_ERROR_MESSAGES[code];
  return code === "club_suspended" && reason ? `${base} Motivo: ${reason}` : base;
}

/** Erro do mercado com o status e a mensagem do contrato. */
export function marketError(code: MarketErrorCode, reason?: string): DomainError {
  return new DomainError(code, STATUS[code], marketErrorMessage(code, reason));
}
