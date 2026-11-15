import { randomBytes, randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { users, wallets } from "../../src/infra/db/schema/index.js";
import { apagarBanco } from "../../partida/banco.js";
import { subirPartida, type Partida } from "../../partida/partida.js";
import { conferirLoginReal } from "../../partida/login-real.js";
import { testDatabaseUrl } from "../support/db.js";

// F17, T9 (critérios 12 e 17): a partida aberta a convidados, com o login de verdade (o Supabase, aqui com chaves de teste).
const SUPABASE = "https://projeto-da-partida.supabase.co";
const SITE = "https://futbolsa-partida.vercel.app";
const nome = `futbolsa_partida_p${randomBytes(3).toString("hex")}`;
let partida: Partida;
let chaves: Awaited<ReturnType<typeof generateKeyPair>>;
let estranhas: Awaited<ReturnType<typeof generateKeyPair>>;

async function tokenDoSupabase(email: string, opcoes: { chave?: typeof chaves } = {}): Promise<string> {
  const agora = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, role: "authenticated", user_metadata: { email_verified: true } })
    .setProtectedHeader({ alg: "ES256", kid: "real" })
    .setSubject(randomUUID())
    .setIssuer(`${SUPABASE}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt(agora)
    .setExpirationTime(agora + 3600)
    .sign((opcoes.chave ?? chaves).privateKey);
}

const comToken = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  chaves = await generateKeyPair("ES256", { extractable: true });
  estranhas = await generateKeyPair("ES256", { extractable: true });
  const jwk = { ...(await exportJWK(chaves.publicKey)), kid: "real", alg: "ES256", use: "sig" };
  process.env.ADMIN_BOOTSTRAP_EMAIL = "dono@exemplo.com";
  partida = await subirPartida({
    urlBanco: testDatabaseUrl(),
    pastaDoSite: "inexistente",
    escala: 0.2,
    portaApi: 0,
    semPortas: true,
    laco: false,
    nomeDoBanco: nome,
    publica: { supabaseUrl: SUPABASE, chaveDeServico: "nao-usada-no-teste", siteOrigem: SITE, chaves: createLocalJWKSet({ keys: [jwk] }) },
  });
}, 240_000);

afterAll(async () => {
  delete process.env.ADMIN_BOOTSTRAP_EMAIL;
  await partida?.fechar().catch(() => undefined);
  await apagarBanco(testDatabaseUrl(), nome);
});

describe("a partida aberta a convidados", () => {
  it("17: só e-mail convidado cria conta; o convidado entra com o token do Supabase e recebe a carteira", async () => {
    const app = partida.servidor.app;
    const db = partida.servidor.conexao.db;
    expect(partida.jogador).toBeNull();
    const convidado = "convidado@exemplo.com";
    // sem convite: recusado
    const sem = await app.inject({ method: "POST", url: "/me", payload: { nickname: "intruso", acceptTerms: true }, headers: comToken(await tokenDoSupabase("intruso@exemplo.com")) });
    expect(sem.statusCode).toBeGreaterThanOrEqual(400);
    expect((await db.select().from(users).where(eq(users.email, "intruso@exemplo.com"))).length).toBe(0);
    // o admin da partida (token interno) convida; o convidado entra
    const convite = await app.inject({ method: "POST", url: "/admin/invites", payload: { emails: [convidado] }, headers: await partida.carga.admin.auth() });
    expect(convite.statusCode).toBeLessThan(300);
    const token = await tokenDoSupabase(convidado);
    const res = await app.inject({ method: "POST", url: "/me", payload: { nickname: "convidado1", acceptTerms: true }, headers: comToken(token) });
    expect(res.statusCode).toBeLessThan(300);
    const [u] = await db.select().from(users).where(eq(users.email, convidado));
    expect(u?.role).toBe("player");
    const [carteira] = await db.select().from(wallets).where(eq(wallets.userId, u!.id));
    expect(Number(carteira?.cash)).toBe(10_000_000);
    expect((await app.inject({ method: "GET", url: "/me", headers: comToken(token) })).statusCode).toBe(200);
  });

  it("12: o e-mail do admin (ADMIN_BOOTSTRAP_EMAIL) entra como admin, sem carteira; convidado e anônimo não passam na rota do relógio", async () => {
    const app = partida.servidor.app;
    const db = partida.servidor.conexao.db;
    const tokenAdmin = await tokenDoSupabase("dono@exemplo.com");
    expect((await app.inject({ method: "POST", url: "/me", payload: { nickname: "dono", acceptTerms: true }, headers: comToken(tokenAdmin) })).statusCode).toBeLessThan(300);
    const [dono] = await db.select().from(users).where(eq(users.email, "dono@exemplo.com"));
    expect(dono?.role).toBe("admin");
    expect((await db.select().from(wallets).where(eq(wallets.userId, dono!.id))).length).toBe(0);
    expect((await app.inject({ method: "GET", url: "/admin/partida", headers: comToken(tokenAdmin) })).statusCode).toBe(200);
    const convidado = await tokenDoSupabase("convidado@exemplo.com");
    expect((await app.inject({ method: "GET", url: "/admin/partida", headers: comToken(convidado) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/partida/relogio", payload: { acao: "dia" }, headers: comToken(convidado) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/partida/relogio", payload: { acao: "dia" } })).statusCode).toBe(401);
  });

  it("token de chave estranha, do emissor interno forjado ou sem assinatura é recusado (401)", async () => {
    const app = partida.servidor.app;
    const estranho = await tokenDoSupabase("dono@exemplo.com", { chave: estranhas });
    expect((await app.inject({ method: "GET", url: "/me", headers: comToken(estranho) })).statusCode).toBe(401);
    // um token que se diz do emissor interno, assinado com chave de fora: falha na assinatura
    const forjado = await new SignJWT({ email: "admin_partida@exemplo.com", role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "teste" })
      .setSubject(randomUUID())
      .setIssuer("https://teste-futbolsa.supabase.co/auth/v1")
      .setAudience("authenticated")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(estranhas.privateKey);
    expect((await app.inject({ method: "POST", url: "/admin/partida/relogio", payload: { acao: "dia" }, headers: comToken(forjado) })).statusCode).toBe(401);
    const cabecalho = Buffer.from('{"alg":"none"}').toString("base64url");
    const corpo = Buffer.from(JSON.stringify({ sub: "x", email: "dono@exemplo.com", role: "authenticated" })).toString("base64url");
    expect((await app.inject({ method: "GET", url: "/me", headers: comToken(`${cabecalho}.${corpo}.`) })).statusCode).toBe(401);
  });

  it("o prazo do token conta no relógio de verdade, não no do jogo (token vencido é recusado)", async () => {
    const agora = Math.floor(Date.now() / 1000);
    const velho = await new SignJWT({ email: "dono@exemplo.com", role: "authenticated" })
      .setProtectedHeader({ alg: "ES256", kid: "real" })
      .setSubject(randomUUID())
      .setIssuer(`${SUPABASE}/auth/v1`)
      .setAudience("authenticated")
      .setIssuedAt(agora - 7200)
      .setExpirationTime(agora - 3600)
      .sign(chaves.privateKey);
    expect((await partida.servidor.app.inject({ method: "GET", url: "/me", headers: comToken(velho) })).statusCode).toBe(401);
  });

  it("CORS só aceita o site da partida; a hora do jogo é pública", async () => {
    const app = partida.servidor.app;
    const pre = (origem: string) => app.inject({ method: "OPTIONS", url: "/me", headers: { origin: origem, "access-control-request-method": "GET" } });
    expect((await pre(SITE)).headers["access-control-allow-origin"]).toBe(SITE);
    // o CORS devolve sempre o endereço do site da partida: o navegador de outro site não casa com ele e bloqueia a resposta
    expect((await pre("https://outro-site.vercel.app")).headers["access-control-allow-origin"]).toBe(SITE);
    expect(process.env.WEB_ORIGIN).toBe(SITE);
    const hora = await app.inject({ method: "GET", url: "/partida/hora" });
    expect(hora.statusCode).toBe(200);
    expect(hora.json()).toEqual({ sim: partida.clock.now().getTime(), run: false });
  });

  it("a subida pública recusa configuração incompleta", () => {
    const ok = { supabaseUrl: SUPABASE, chaveDeServico: "x", siteOrigem: SITE };
    expect(() => conferirLoginReal(ok)).not.toThrow();
    expect(() => conferirLoginReal({ ...ok, siteOrigem: `${SITE}/` })).toThrow(/sem barra/);
    expect(() => conferirLoginReal({ ...ok, siteOrigem: "http://futbolsa.vercel.app" })).toThrow(/https/);
    expect(() => conferirLoginReal({ ...ok, supabaseUrl: "" })).toThrow(/SUPABASE_URL/);
    expect(() => conferirLoginReal({ ...ok, chaveDeServico: "" })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
