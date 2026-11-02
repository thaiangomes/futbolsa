import { ACCOUNT_ERROR_MESSAGES } from "@futbolsa/contracts";
import { DomainError } from "../http/errors.js";

/**
 * Quem está por trás de um token, no que o jogo precisa saber. Nada de nome nem foto: o jogo
 * guarda só o e-mail (Conta e login, critério 20).
 */
export interface AuthIdentity {
  /** O sistema de login que emitiu o token (`supabase`; outro, se o jogo for para o login da empresa). */
  provider: string;
  /** A identidade da pessoa nesse sistema (o `sub` do token). */
  subject: string;
  /** Em minúsculas, sem espaços nas pontas. */
  email: string;
  emailVerified: boolean;
  /** Quando a pessoa digitou a senha ou passou pelo Google pela última vez (exclusão e troca de senha). */
  authenticatedAt: Date;
  /** Quando o token vence (o WebSocket fecha a conexão nessa hora). */
  expiresAt: Date;
}

/**
 * O adaptador de login (Arquitetura da Fase 1, Segurança): a API só fala com o login por esta
 * interface. Trocar o Supabase pelo login da empresa é escrever outra implementação.
 */
export abstract class AuthVerifier {
  /** Confere o token e devolve a identidade; recusa com `invalid_token` sem dizer o motivo. */
  abstract verify(token: string): Promise<AuthIdentity>;
  /** Apaga a identidade no sistema de login (exclusão da conta). Já apagada conta como feito. */
  abstract deleteIdentity(subject: string): Promise<void>;
}

/** Token recusado. O motivo fica só no servidor; o cliente recebe sempre a mesma resposta. */
export class InvalidTokenError extends DomainError {
  constructor(readonly reason: string) {
    super("invalid_token", 401, ACCOUNT_ERROR_MESSAGES.invalid_token);
  }
}

/** Normaliza o e-mail como o jogo guarda: minúsculas, sem espaços nas pontas. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
