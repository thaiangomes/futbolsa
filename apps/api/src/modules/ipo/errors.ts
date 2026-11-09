import { IPO_ERROR_MESSAGES, type IpoErrorCode } from "@futbolsa/contracts";
import { DomainError } from "../../infra/http/index.js";

/**
 * O status HTTP de cada recusa do IPO, no padrão das outras rotas: 400 para entrada mal formada,
 * 404 para o que não existe (clube fora da lista, oferta que não há), 409 para o estado do jogo
 * (período fechado, oferta já existente, conta sem carteira), 422 para a regra do dinheiro (piso da
 * faixa, caixa livre, caixa negativo) e 403 para a conta bloqueada.
 */
const STATUS: Record<IpoErrorCode, number> = {
  ipo_not_open: 409,
  ipo_closed: 409,
  club_not_listed: 404,
  bid_exists: 409,
  bid_not_found: 404,
  invalid_quantity: 400,
  invalid_price: 400,
  below_band_floor: 422,
  insufficient_cash: 422,
  account_blocked: 403,
  negative_cash: 422,
  no_wallet: 409,
  ipo_close_earlier: 422,
  ipo_close_too_late: 422,
  ipo_not_ready: 409,
};

/** Erro do IPO com o status e a mensagem do contrato. */
export function ipoError(code: IpoErrorCode): DomainError {
  return new DomainError(code, STATUS[code], IPO_ERROR_MESSAGES[code]);
}
