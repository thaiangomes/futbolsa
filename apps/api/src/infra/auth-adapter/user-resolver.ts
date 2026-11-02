import type { UserRole, UserStatus } from "@futbolsa/contracts";
import type { AuthIdentity } from "./auth-verifier.js";

/** O usuário do jogo por trás de uma identidade, lido do banco a cada chamada. */
export interface ResolvedUser {
  id: string;
  role: UserRole;
  status: UserStatus;
}

/**
 * Porta entre o login e as contas do jogo: dada uma identidade conferida, qual usuário do jogo
 * ela é (ou nenhum, se a pessoa ainda não fez o cadastro). Implementada pelo módulo `accounts`;
 * os guards e o WebSocket usam só esta porta.
 */
export abstract class UserResolver {
  abstract resolve(identity: AuthIdentity): Promise<ResolvedUser | null>;
}
