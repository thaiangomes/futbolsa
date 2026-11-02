import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Clock } from "../clock/clock.js";
import { type AuthIdentity, AuthVerifier, InvalidTokenError, normalizeEmail } from "./auth-verifier.js";

/** Só assinaturas assimétricas: o segredo compartilhado antigo (`HS256`) é recusado. */
const ALGORITHMS = ["ES256", "RS256"];
/** Folga para a diferença entre o relógio da API e o do Supabase. */
const CLOCK_TOLERANCE_S = 30;

/** Apaga o usuário no sistema de login. */
export interface IdentityAdmin {
  deleteUser(subject: string): Promise<void>;
}

/** A API de administração do Supabase, com a chave de serviço (segredo só da API). */
export class SupabaseIdentityAdmin implements IdentityAdmin {
  constructor(
    private readonly supabaseUrl: string,
    private readonly serviceKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async deleteUser(subject: string): Promise<void> {
    const res = await this.fetchFn(`${this.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(subject)}`, {
      method: "DELETE",
      headers: { apikey: this.serviceKey, Authorization: `Bearer ${this.serviceKey}` },
    });
    // 404: a identidade já não existe, que é o que se queria
    if (res.ok || res.status === 404) return;
    throw new Error(`o Supabase recusou apagar a identidade (HTTP ${res.status})`);
  }
}

export interface SupabaseVerifierOptions {
  /** `https://<projeto>.supabase.co`, sem barra no fim. */
  supabaseUrl: string;
  /** As chaves públicas do projeto; o padrão busca `/auth/v1/.well-known/jwks.json` e guarda em cache. */
  keys?: JWTVerifyGetKey;
  clock: Clock;
  admin: IdentityAdmin;
}

/**
 * Confere o token de acesso do Supabase pela assinatura (chaves públicas do projeto), emissor,
 * audiência, validade (pelo relógio da API), papel `authenticated` e conta não anônima.
 */
export class SupabaseAuthVerifier extends AuthVerifier {
  private readonly issuer: string;
  private readonly keys: JWTVerifyGetKey;

  constructor(private readonly options: SupabaseVerifierOptions) {
    super();
    this.issuer = `${options.supabaseUrl}/auth/v1`;
    this.keys = options.keys ?? createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<AuthIdentity> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: "authenticated",
        algorithms: ALGORITHMS,
        currentDate: this.options.clock.now(),
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ["sub", "exp", "iat"],
      }));
    } catch (error) {
      const reason = error instanceof joseErrors.JOSEError ? error.code : "token_unreadable";
      throw new InvalidTokenError(reason);
    }
    if (payload.role !== "authenticated") throw new InvalidTokenError("role");
    if (payload.is_anonymous === true) throw new InvalidTokenError("anonymous");
    if (typeof payload.sub !== "string" || payload.sub === "") throw new InvalidTokenError("sub");
    if (typeof payload.email !== "string" || payload.email.trim() === "") throw new InvalidTokenError("email");

    // Só a confirmação explícita conta: sem ela, a identidade não liga a uma conta existente
    // pelo e-mail (Arquitetura da Fase 1, Segurança). Nome e foto do Google ficam de fora.
    const metadata = (payload.user_metadata ?? {}) as Record<string, unknown>;
    return {
      provider: "supabase",
      subject: payload.sub,
      email: normalizeEmail(payload.email),
      emailVerified: metadata.email_verified === true,
      authenticatedAt: lastAuthentication(payload),
      expiresAt: new Date(payload.exp! * 1000),
    };
  }

  deleteIdentity(subject: string): Promise<void> {
    return this.options.admin.deleteUser(subject);
  }
}

/** O último login, pelo `amr` (métodos usados, com o horário); sem ele, a emissão do token. */
function lastAuthentication(payload: JWTPayload): Date {
  const amr = Array.isArray(payload.amr) ? (payload.amr as Array<{ timestamp?: unknown }>) : [];
  const times = amr.map((m) => m?.timestamp).filter((t): t is number => typeof t === "number");
  return new Date((times.length ? Math.max(...times) : payload.iat!) * 1000);
}

/** Sem o Supabase configurado (testes da F1, desenvolvimento sem login), todo token é recusado. */
export class UnconfiguredAuthVerifier extends AuthVerifier {
  async verify(): Promise<AuthIdentity> {
    throw new InvalidTokenError("unconfigured");
  }

  async deleteIdentity(): Promise<void> {
    throw new Error("login não configurado: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  }
}
