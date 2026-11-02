import { Injectable } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";

/**
 * Limites de uso por nome (Arquitetura da Fase 1, Segurança): cada fase aplica o seu com
 * `@RateLimit(nome)`. As demais rotas ficam no limite geral, folgado. Os bots não passam
 * pelo HTTP, então não contam aqui.
 */
export const RATE_LIMITS = {
  /** Geral, por pessoa: 300 chamadas por minuto. */
  default: { limit: 300, ttl: 60_000 },
  /** Cadastro e troca de apelido. */
  signup: { limit: 10, ttl: 60_000 },
  /** Ordens (F9). */
  orders: { limit: 60, ttl: 60_000 },
  /** Ofertas do IPO (F8). */
  bids: { limit: 60, ttl: 60_000 },
} as const;

export type RateLimitName = Exclude<keyof typeof RATE_LIMITS, "default">;

/** Aplica um limite com nome a uma rota ou a um controller. */
export const RateLimit = (name: RateLimitName) => Throttle({ default: RATE_LIMITS[name] });

/**
 * Conta por pessoa logada (o id do usuário do jogo, ou a identidade de quem ainda não tem
 * conta) e, sem login, pelo IP. Roda depois do guard de login, que identifica a pessoa.
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const auth = req.auth as { user?: { id: string }; identity?: { subject: string } } | undefined;
    if (auth?.user) return `user:${auth.user.id}`;
    if (auth?.identity) return `identity:${auth.identity.subject}`;
    return `ip:${String(req.ip)}`;
  }
}
