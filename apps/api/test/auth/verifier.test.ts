import { describe, expect, it } from "vitest";
import { SignJWT, UnsecuredJWT, exportSPKI } from "jose";
import { createHmac } from "node:crypto";
import { FixedClock } from "../../src/infra/clock/index.js";
import { InvalidTokenError, SupabaseIdentityAdmin } from "../../src/infra/auth-adapter/index.js";
import { strangerKeys, testVerifier, TEST_ISSUER, TOKEN_T0, tokenFor } from "../support/auth.js";

const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
const verifier = testVerifier(clock);
const SUB = "4c1b2f0e-7d9a-4a51-9a0c-0f1e2d3c4b5a";

async function rejected(token: string): Promise<InvalidTokenError> {
  const error = await verifier.verify(token).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(InvalidTokenError);
  const e = error as InvalidTokenError;
  // o cliente recebe sempre o mesmo: código e mensagem, sem o motivo
  expect(e.code).toBe("invalid_token");
  expect(e.status).toBe(401);
  expect(e.message).not.toMatch(/exp|assinatura|signature|issuer|aud/i);
  return e;
}

describe("adaptador de login do Supabase", () => {
  it("token válido devolve a identidade, com o e-mail normalizado", async () => {
    const at = new Date(TOKEN_T0.getTime() - 10 * 60_000);
    const token = await tokenFor({ subject: SUB, email: "  Ana@Exemplo.com ", authenticatedAt: at });
    const id = await verifier.verify(token);
    expect(id).toEqual({
      provider: "supabase",
      subject: SUB,
      email: "ana@exemplo.com",
      emailVerified: true,
      authenticatedAt: at,
      expiresAt: new Date(TOKEN_T0.getTime() + 3600_000),
    });
  });

  it("conta 20: nome e foto do Google não aparecem na identidade", async () => {
    const token = await tokenFor({
      subject: SUB,
      claims: {
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: { email_verified: true, full_name: "Ana Souza", name: "Ana Souza", avatar_url: "https://foto" },
      },
    });
    const id = await verifier.verify(token);
    expect(JSON.stringify(id)).not.toMatch(/Ana Souza|foto/);
    expect(Object.keys(id).sort()).toEqual(["authenticatedAt", "email", "emailVerified", "expiresAt", "provider", "subject"]);
  });

  it("conta 5: e-mail não confirmado chega como emailVerified falso (quem recusa é o guard)", async () => {
    expect((await verifier.verify(await tokenFor({ subject: SUB, emailVerified: false }))).emailVerified).toBe(false);
    const semClaim = await tokenFor({ subject: SUB, claims: { user_metadata: {} } });
    expect((await verifier.verify(semClaim)).emailVerified).toBe(false);
  });

  it("recusa token vencido, inclusive além da folga de 30 s", async () => {
    const old = await tokenFor({ subject: SUB, at: new Date(TOKEN_T0.getTime() - 2 * 3600_000), expiresIn: 3600 });
    await rejected(old);
    // venceu há 20 s: dentro da folga
    const justExpired = await tokenFor({ subject: SUB, at: new Date(clock.now().getTime() - 3620_000), expiresIn: 3600 });
    await expect(verifier.verify(justExpired)).resolves.toBeTruthy();
  });

  it("recusa token com nbf no futuro", async () => {
    await rejected(await tokenFor({ subject: SUB, claims: { nbf: Math.floor(clock.now().getTime() / 1000) + 600 } }));
  });

  it("recusa emissor de outro projeto e audiência errada", async () => {
    await rejected(await tokenFor({ subject: SUB, issuer: "https://outro-projeto.supabase.co/auth/v1" }));
    await rejected(await tokenFor({ subject: SUB, audience: "anon" }));
  });

  it("recusa token assinado por outra chave", async () => {
    await rejected(await tokenFor({ subject: SUB, privateKey: strangerKeys.privateKey }));
  });

  it("recusa alg none", async () => {
    const now = Math.floor(clock.now().getTime() / 1000);
    const unsigned = new UnsecuredJWT({ role: "authenticated", email: "a@exemplo.com", user_metadata: { email_verified: true } })
      .setSubject(SUB)
      .setIssuer(TEST_ISSUER)
      .setAudience("authenticated")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .encode();
    await rejected(unsigned);
  });

  it("recusa HS256 assinado com a chave pública como segredo (confusão de algoritmo)", async () => {
    const pem = await exportSPKI(strangerKeys.publicKey);
    const now = Math.floor(clock.now().getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "teste" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({ sub: SUB, role: "authenticated", email: "a@exemplo.com", iss: TEST_ISSUER, aud: "authenticated", iat: now, exp: now + 600 }),
    ).toString("base64url");
    const sig = createHmac("sha256", pem).update(`${header}.${body}`).digest("base64url");
    await rejected(`${header}.${body}.${sig}`);
    // e o HS256 "de verdade", com um segredo compartilhado, também
    const hs = await new SignJWT({ role: "authenticated", email: "a@exemplo.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(SUB)
      .setIssuer(TEST_ISSUER)
      .setAudience("authenticated")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode("segredo-compartilhado-antigo-do-projeto"));
    await rejected(hs);
  });

  it("recusa token sem sub, com papel anon, anônimo ou sem e-mail", async () => {
    await rejected(await tokenFor({ subject: "" }));
    await rejected(await tokenFor({ subject: SUB, claims: { role: "anon" } }));
    await rejected(await tokenFor({ subject: SUB, claims: { is_anonymous: true } }));
    await rejected(await tokenFor({ subject: SUB, email: null }));
    await rejected(await tokenFor({ subject: SUB, email: "   " }));
  });

  it("recusa texto que não é JWT", async () => {
    await rejected("nao-e-um-token");
    await rejected("");
    await rejected("a.b.c");
  });
});

describe("apagar a identidade no Supabase", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (status: number) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status });
    }) as typeof fetch;

  it("chama a rota de administração com a chave de serviço", async () => {
    calls.length = 0;
    const admin = new SupabaseIdentityAdmin("https://p.supabase.co", "chave-servico", fakeFetch(200));
    await admin.deleteUser(SUB);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://p.supabase.co/auth/v1/admin/users/${SUB}`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.init.headers).toEqual({ apikey: "chave-servico", Authorization: "Bearer chave-servico" });
  });

  it("404 conta como já apagada; outro erro sobe para a tarefa tentar de novo", async () => {
    await expect(new SupabaseIdentityAdmin("https://p.supabase.co", "k", fakeFetch(404)).deleteUser(SUB)).resolves.toBeUndefined();
    await expect(new SupabaseIdentityAdmin("https://p.supabase.co", "k", fakeFetch(500)).deleteUser(SUB)).rejects.toThrow(/HTTP 500/);
  });

  it("o id vai codificado na URL", async () => {
    calls.length = 0;
    await new SupabaseIdentityAdmin("https://p.supabase.co", "k", fakeFetch(200)).deleteUser("../../outra-rota");
    expect(calls[0]!.url).toBe("https://p.supabase.co/auth/v1/admin/users/..%2F..%2Foutra-rota");
  });
});
