import { Global, Logger, Module } from "@nestjs/common";
import { Clock } from "../clock/clock.js";
import { AuthVerifier } from "./auth-verifier.js";
import { SupabaseAuthVerifier, SupabaseIdentityAdmin, UnconfiguredAuthVerifier } from "./supabase-verifier.js";

/** O verificador do Supabase pelas variáveis de ambiente, ou um que recusa tudo sem elas. */
export function authVerifierFromEnv(clock: Clock, env: NodeJS.ProcessEnv = process.env): AuthVerifier {
  const url = env.SUPABASE_URL?.replace(/\/+$/, "");
  if (!url) {
    new Logger("Login").warn("SUPABASE_URL vazio: a API recusa todo token até o login ser configurado");
    return new UnconfiguredAuthVerifier();
  }
  const admin = new SupabaseIdentityAdmin(url, env.SUPABASE_SERVICE_ROLE_KEY ?? "");
  return new SupabaseAuthVerifier({ supabaseUrl: url, clock, admin });
}

/** Adaptador de login (Supabase). Global: os guards e o WebSocket injetam `AuthVerifier`. */
@Global()
@Module({
  providers: [{ provide: AuthVerifier, useFactory: (clock: Clock) => authVerifierFromEnv(clock), inject: [Clock] }],
  exports: [AuthVerifier],
})
export class AuthAdapterModule {}
