import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type { TestingModuleBuilder } from "@nestjs/testing";
import { AuthVerifier, type IdentityAdmin, SupabaseAuthVerifier } from "../../src/infra/auth-adapter/index.js";
import type { Clock } from "../../src/infra/clock/index.js";

/**
 * Login nos testes: um par de chaves gerado na hora faz o papel das chaves do projeto do
 * Supabase, e os tokens passam pelo mesmo `SupabaseAuthVerifier` de produção. Para as fases
 * seguintes: `tokenFor` cria o token de qualquer pessoa e `withTestAuth` troca o verificador
 * da aplicação de teste.
 */

export const TEST_SUPABASE_URL = "https://teste-futbolsa.supabase.co";
export const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;

/** Instante padrão dos tokens: o mesmo `T0` das fixtures (2027-04-01 13:00 UTC). */
export const TOKEN_T0 = new Date("2027-04-01T13:00:00Z");

const projectKeys = await generateKeyPair("ES256", { extractable: true });
const publicJwk: JWK = { ...(await exportJWK(projectKeys.publicKey)), kid: "teste", alg: "ES256", use: "sig" };

/** As chaves públicas do "projeto" de teste. */
export const testKeySet = createLocalJWKSet({ keys: [publicJwk] });

/** Outra chave, de quem não é o projeto: tokens assinados por ela são recusados. */
export const strangerKeys = await generateKeyPair("ES256", { extractable: true });

export interface TokenOptions {
  subject: string;
  /** `null` tira o e-mail do token. */
  email?: string | null;
  emailVerified?: boolean;
  /** Emissão; o padrão é `TOKEN_T0`. */
  at?: Date;
  /** Validade em segundos (padrão: 1 hora, como no Supabase). */
  expiresIn?: number;
  /** Último login (`amr`); o padrão é a emissão. */
  authenticatedAt?: Date;
  /** Claims a mais ou trocados (`role`, `is_anonymous`, `user_metadata`…). */
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  /** Assinar com outra chave privada. */
  privateKey?: CryptoKey;
}

/** Um token de acesso no formato do Supabase, assinado pela chave do projeto de teste. */
export async function tokenFor(o: TokenOptions): Promise<string> {
  const at = o.at ?? TOKEN_T0;
  const iat = Math.floor(at.getTime() / 1000);
  const authenticated = Math.floor((o.authenticatedAt ?? at).getTime() / 1000);
  const email = o.email === undefined ? `${o.subject}@exemplo.com` : o.email;
  const payload: Record<string, unknown> = {
    role: "authenticated",
    is_anonymous: false,
    aal: "aal1",
    amr: [{ method: "password", timestamp: authenticated }],
    session_id: `sessao-${o.subject}`,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { email_verified: o.emailVerified ?? true },
    ...(email === null ? {} : { email }),
    ...o.claims,
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: "teste", typ: "JWT" })
    .setSubject(o.subject)
    .setIssuer(o.issuer ?? TEST_ISSUER)
    .setAudience(o.audience ?? "authenticated")
    .setIssuedAt(iat)
    .setExpirationTime(iat + (o.expiresIn ?? 3600))
    .sign(o.privateKey ?? projectKeys.privateKey);
}

/** Cabeçalho de autorização para o `app.inject`. */
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** O sistema de login falso: guarda o que foi apagado e pode falhar de propósito. */
export class FakeIdentityAdmin implements IdentityAdmin {
  readonly deleted: string[] = [];
  /** Quantas das próximas chamadas falham. */
  failNext = 0;

  async deleteUser(subject: string): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Supabase fora do ar (falso)");
    }
    this.deleted.push(subject);
  }
}

/** O verificador de produção com as chaves de teste e o relógio dado. */
export function testVerifier(clock: Clock, admin: IdentityAdmin = new FakeIdentityAdmin()): SupabaseAuthVerifier {
  return new SupabaseAuthVerifier({ supabaseUrl: TEST_SUPABASE_URL, keys: testKeySet, clock, admin });
}

/** Troca o verificador da aplicação de teste pelo de chaves de teste (use em `createTestApp({ override })`). */
export function withTestAuth(clock: Clock, admin: IdentityAdmin = new FakeIdentityAdmin()) {
  return (builder: TestingModuleBuilder) => builder.overrideProvider(AuthVerifier).useValue(testVerifier(clock, admin));
}
