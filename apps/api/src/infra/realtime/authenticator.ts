import type { AuthErrorCode } from "@futbolsa/contracts";

/** Quem está por trás de um token, no que o tempo real precisa saber. Nada de e-mail. */
export interface RealtimeIdentity {
  /** O id do usuário do jogo (a chave do canal `me`). */
  userId: string;
  role: "player" | "admin";
  /** O bloqueado assina o `me` (lê a própria carteira) e só não negocia. */
  status: "active" | "blocked";
}

export type AuthResult = { ok: true; identity: RealtimeIdentity } | { ok: false; code: AuthErrorCode };

/**
 * A porta do login do WebSocket. A implementação real (T12) confere o token com o
 * `AuthVerifier` da F5 e consulta o usuário do jogo; até lá vale a versão falsa.
 * `invalid_token` derruba a conexão; `no_account` e `account_deleted` deixam ela como visitante.
 */
export abstract class RealtimeAuthenticator {
  abstract authenticate(token: string): Promise<AuthResult>;
}
