import { applyDecorators, createParamDecorator, type ExecutionContext, SetMetadata, UseGuards } from "@nestjs/common";
import type { AuthIdentity } from "./auth-verifier.js";
import type { ResolvedUser } from "./user-resolver.js";
import { AdminGuard } from "./admin.guard.js";

/** O que o guard de login deixa na requisição. */
export interface RequestAuth {
  identity: AuthIdentity;
  /** Nulo para quem entrou mas ainda não fez o cadastro (só em `@AllowUnregistered`). */
  user: ResolvedUser | null;
}

export const IS_PUBLIC = "futbolsa:public";
export const ALLOW_UNREGISTERED = "futbolsa:allow-unregistered";

/**
 * Rota sem login. Toda rota pede login por padrão; esta marca é a exceção, e a lista de rotas
 * públicas do teste de varredura (`test/auth/routes-scan.test.ts`) precisa ser atualizada junto.
 * Com um token válido, a rota recebe o usuário mesmo assim (por exemplo, o saldo livre no livro).
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Rota para quem já entrou mas ainda não tem conta do jogo: só `GET /me` e `POST /me`. */
export const AllowUnregistered = () => SetMetadata(ALLOW_UNREGISTERED, true);

/** Só admin ativo, com o papel lido do banco a cada chamada. Use em todo controller de `/admin`. */
export const AdminOnly = () => applyDecorators(UseGuards(AdminGuard));

function authOf(ctx: ExecutionContext): RequestAuth | undefined {
  return ctx.switchToHttp().getRequest<{ auth?: RequestAuth }>().auth;
}

/** O usuário do jogo da chamada (nas rotas com login, nunca nulo). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): ResolvedUser => {
  const user = authOf(ctx)?.user;
  if (!user) throw new Error("@CurrentUser numa rota sem usuário: use @CurrentAuth");
  return user;
});

/** Identidade e usuário (que pode ser nulo em `@AllowUnregistered` ou numa rota pública). */
export const CurrentAuth = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestAuth | undefined => authOf(ctx),
);
