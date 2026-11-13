import { ENTRY_ERROR_MESSAGES, type EntryErrorCode } from "@futbolsa/contracts";
import { DomainError } from "../../infra/http/index.js";

/** O status HTTP de cada recusa da entrada: 409 para o estado do jogo, 403 para a conta bloqueada, 503 para a fila cheia. */
const STATUS: Record<EntryErrorCode, number> = {
  entry_not_open: 409,
  entry_not_ready: 409,
  market_suspended: 409,
  entry_window_closed: 409,
  already_entered: 409,
  account_blocked: 403,
  entry_busy: 503,
};

/** Erro da entrada com o status e a mensagem do contrato; `detail` acrescenta texto (o motivo da suspensão). */
export function entryError(code: EntryErrorCode, detail?: string): DomainError {
  const message = detail ? `${ENTRY_ERROR_MESSAGES[code]} Motivo: ${detail}` : ENTRY_ERROR_MESSAGES[code];
  return new DomainError(code, STATUS[code], message);
}
