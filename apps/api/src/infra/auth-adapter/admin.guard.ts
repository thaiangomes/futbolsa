import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { ACCOUNT_ERROR_MESSAGES } from "@futbolsa/contracts";
import { DomainError } from "../http/errors.js";
import type { ResolvedUser } from "./user-resolver.js";

/**
 * Só admin ativo passa (Admin, critério 31). Roda depois do guard de login, que leu o papel e
 * a situação do banco nesta mesma chamada: quem perde o papel perde o acesso na chamada
 * seguinte, com o mesmo token. Admin bloqueado não passa.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx.switchToHttp().getRequest<{ auth?: { user: ResolvedUser | null } }>().auth?.user;
    if (user?.role === "admin" && user.status === "active") return true;
    throw new DomainError("admin_required", 403, ACCOUNT_ERROR_MESSAGES.admin_required);
  }
}
