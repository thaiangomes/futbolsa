import { Injectable } from "@nestjs/common";
import { DomainError } from "../http/errors.js";
import { AuthVerifier } from "../auth-adapter/auth-verifier.js";
import { UserResolver } from "../auth-adapter/user-resolver.js";
import { RealtimeAuthenticator, type AuthResult } from "./authenticator.js";

/**
 * O login do WebSocket com as contas da F5: confere o token com o `AuthVerifier` e pergunta ao
 * `UserResolver` qual usuário do jogo é (a mesma dupla do `AuthGuard` das rotas REST).
 * - token recusado → `invalid_token` (a conexão fecha com 4401);
 * - sem conta, ou e-mail ainda não confirmado → `no_account` (a conexão segue como visitante);
 * - conta excluída → `account_deleted` (idem);
 * - jogador bloqueado entra: ele lê a própria carteira e só não negocia.
 */
@Injectable()
export class AuthFromAccounts extends RealtimeAuthenticator {
  constructor(
    private readonly verifier: AuthVerifier,
    private readonly users: UserResolver,
  ) {
    super();
  }

  async authenticate(token: string): Promise<AuthResult> {
    let identity;
    try {
      identity = await this.verifier.verify(token);
    } catch (error) {
      // o verificador recusa com um erro de domínio (`invalid_token`); o resto é falha de verdade e sobe
      if (error instanceof DomainError) return { ok: false, code: "invalid_token" };
      throw error;
    }
    if (!identity.emailVerified) return { ok: false, code: "no_account" };

    const user = await this.users.resolve(identity);
    if (!user) return { ok: false, code: "no_account" };
    if (user.status === "deleted") return { ok: false, code: "account_deleted" };
    return { ok: true, identity: { userId: user.id, role: user.role, status: user.status } };
  }
}
