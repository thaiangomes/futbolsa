import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { ErrorFilter } from "./error.filter.js";
import { RATE_LIMITS, RateLimitGuard } from "./rate-limit.js";

/** HTTP sem regra de jogo: formato dos erros e limites de uso. */
@Module({
  imports: [ThrottlerModule.forRoot({ throttlers: [{ name: "default", ...RATE_LIMITS.default }] })],
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class HttpInfraModule {}
