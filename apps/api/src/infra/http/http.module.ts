import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { AuthGuard } from "../auth-adapter/auth.guard.js";
import { ErrorFilter } from "./error.filter.js";
import { RATE_LIMITS, RateLimitGuard } from "./rate-limit.js";

/**
 * HTTP sem regra de jogo: formato dos erros, login em toda rota e limites de uso. A ordem dos
 * guards importa: o de login primeiro, para o limite contar por pessoa.
 */
@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: [{ name: "default", ...RATE_LIMITS.default }] })],
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class HttpInfraModule {}
