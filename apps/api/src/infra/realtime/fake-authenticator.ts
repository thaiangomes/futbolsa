import { Injectable } from "@nestjs/common";
import type { AuthErrorCode } from "@futbolsa/contracts";
import { RealtimeAuthenticator, type AuthResult, type RealtimeIdentity } from "./authenticator.js";

/**
 * Autenticador de teste, até a F5 entregar o login real. Só aceita os tokens que o teste
 * registrou; qualquer outro é `invalid_token`. Sem registro nenhum, ninguém entra.
 */
@Injectable()
export class FakeRealtimeAuthenticator extends RealtimeAuthenticator {
  private readonly results = new Map<string, AuthResult>();

  /** O token passa a valer como esta pessoa. */
  add(token: string, identity: RealtimeIdentity): this {
    this.results.set(token, { ok: true, identity });
    return this;
  }

  /** O token passa a dar este erro (`no_account`, `account_deleted`...). */
  addFailure(token: string, code: AuthErrorCode): this {
    this.results.set(token, { ok: false, code });
    return this;
  }

  async authenticate(token: string): Promise<AuthResult> {
    return this.results.get(token) ?? { ok: false, code: "invalid_token" };
  }
}
