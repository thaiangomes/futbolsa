import { ACCOUNT_ERROR_MESSAGES, type AccountErrorCode } from "@futbolsa/contracts";
import { pgErrorCode } from "../../infra/db/index.js";
import { DomainError } from "../../infra/http/index.js";

const STATUS: Record<AccountErrorCode, number> = {
  invalid_token: 401,
  email_not_confirmed: 403,
  registration_required: 403,
  account_deleted: 401,
  invite_required: 403,
  already_registered: 409,
  nickname_taken: 409,
  nickname_reserved: 400,
  terms_required: 400,
  admin_required: 403,
  last_admin: 409,
  reauth_required: 401,
  invite_used: 409,
};

/** Erro de conta com o status e a mensagem do contrato. */
export function accountError(code: AccountErrorCode): DomainError {
  return new DomainError(code, STATUS[code], ACCOUNT_ERROR_MESSAGES[code]);
}

/** O nome da restrição única violada (`23505`), procurando nas causas (o Drizzle embrulha). */
export function uniqueViolation(error: unknown): string | undefined {
  if (pgErrorCode(error) !== "23505") return undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

/** Traduz a corrida do apelido e do cadastro duplicado nos códigos do contrato. */
export function mapUniqueViolation(error: unknown): unknown {
  const constraint = uniqueViolation(error);
  if (constraint === undefined) return error;
  if (constraint === "users_nickname_lower_key") return accountError("nickname_taken");
  return accountError("already_registered");
}
