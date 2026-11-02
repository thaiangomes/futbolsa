import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ACCOUNT_ERROR_MESSAGES, type AccountErrorCode } from "@futbolsa/contracts";
import { DomainError } from "../http/errors.js";
import { AuthVerifier, InvalidTokenError } from "./auth-verifier.js";
import { ALLOW_UNREGISTERED, IS_PUBLIC, type RequestAuth } from "./decorators.js";
import { UserResolver } from "./user-resolver.js";

const STATUS: Partial<Record<AccountErrorCode, number>> = {
  email_not_confirmed: 403,
  registration_required: 403,
  account_deleted: 401,
};

const deny = (code: AccountErrorCode) => new DomainError(code, STATUS[code] ?? 401, ACCOUNT_ERROR_MESSAGES[code]);

/**
 * Login em toda rota, seguro por padrão (Arquitetura da Fase 1, Segurança): sem `@Public()`,
 * a rota pede um token válido, com e-mail confirmado, de uma conta do jogo não excluída. O
 * token vem só do cabeçalho `Authorization: Bearer`, nunca da URL (iria parar em logs) nem de
 * cookie. O usuário bloqueado passa: ele lê a própria carteira e quem o impede de negociar é
 * o serviço de cada módulo, dentro da transação (decisão do Thaian em 2026-11-01).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: AuthVerifier,
    private readonly users: UserResolver,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const request = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown>; auth?: RequestAuth }>();
    const token = bearerToken(request.headers.authorization);

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      // Rota pública: com um token válido de uma conta ativa, ela recebe o usuário; sem, segue sem.
      if (token) request.auth = await this.tryAuthenticate(token);
      return true;
    }

    if (!token) throw new InvalidTokenError("missing");
    const identity = await this.verifier.verify(token);
    if (!identity.emailVerified) throw deny("email_not_confirmed");
    const user = await this.users.resolve(identity);
    if (user?.status === "deleted") throw deny("account_deleted");
    if (!user && !this.reflector.getAllAndOverride<boolean>(ALLOW_UNREGISTERED, targets)) {
      throw deny("registration_required");
    }
    request.auth = { identity, user };
    return true;
  }

  private async tryAuthenticate(token: string): Promise<RequestAuth | undefined> {
    try {
      const identity = await this.verifier.verify(token);
      if (!identity.emailVerified) return undefined;
      const user = await this.users.resolve(identity);
      return user && user.status !== "deleted" ? { identity, user } : undefined;
    } catch (error) {
      if (error instanceof DomainError) return undefined;
      throw error;
    }
  }
}

/** O token do cabeçalho `Authorization: Bearer <token>`; qualquer outro formato conta como sem token. */
function bearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header.trim());
  return match?.[1];
}
