/**
 * Conferência do login no projeto do Supabase (tarefa A11 do Plano de login e contas). Só lê,
 * a não ser que `SUPABASE_CHECK_DELETE_SUBJECT` seja dado. Rodar da raiz, com o `.env` preenchido:
 *
 *   npm run auth:check -w @futbolsa/api
 *   SUPABASE_TEST_TOKEN=<token de um usuário de teste> npm run auth:check -w @futbolsa/api
 *   (ou SUPABASE_TEST_EMAIL e SUPABASE_TEST_PASSWORD no .env: o script entra sozinho com o usuário de teste)
 *
 * O token de teste sai do site depois de entrar com um usuário criado no painel (ou de
 * `supabase.auth.getSession()` no console do navegador). Nada aqui imprime o token nem e-mail inteiro.
 */
import { SystemClock } from "../src/infra/clock/index.js";
import { authVerifierFromEnv } from "../src/infra/auth-adapter/index.js";

const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
let failures = 0;

function report(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FALHA"} ${label}${detail ? `: ${detail}` : ""}`);
}

const mask = (email: string) => email.replace(/^(.).*(@.*)$/, "$1***$2");

if (!url) {
  console.error("SUPABASE_URL vazio: preencha o .env (veja o .env.example).");
  process.exit(1);
}

// 1. Chaves públicas: precisam ser assimétricas, porque a API recusa o HS256.
const jwks = (await fetch(`${url}/auth/v1/.well-known/jwks.json`).then((r) => r.json())) as { keys?: Array<{ alg?: string; kty?: string }> };
const algs = (jwks.keys ?? []).map((k) => k.alg ?? k.kty ?? "?");
report(algs.some((a) => a === "ES256" || a === "RS256"), "chaves de assinatura assimétricas (JWT Signing Keys)", algs.join(", ") || "nenhuma");

// 2. Configuração pública do login.
if (publishable) {
  const settings = (await fetch(`${url}/auth/v1/settings`, { headers: { apikey: publishable } }).then((r) => r.json())) as {
    external?: Record<string, boolean>;
    mailer_autoconfirm?: boolean;
    disable_signup?: boolean;
  };
  report(settings.external?.email === true, "login por e-mail e senha ligado");
  // O botão do Google fica escondido até NEXT_PUBLIC_GOOGLE_LOGIN=true; só então o Google precisa estar ligado.
  if (process.env.NEXT_PUBLIC_GOOGLE_LOGIN === "true") report(settings.external?.google === true, "login pelo Google ligado");
  else console.log("     (login pelo Google não conferido: o botão está escondido, NEXT_PUBLIC_GOOGLE_LOGIN != true)");
  report(settings.mailer_autoconfirm === false, "confirmação de e-mail ligada (Confirm email)");
  report(settings.external?.anonymous_users !== true, "login anônimo desligado");
  report(settings.disable_signup !== true, "cadastro no Supabase aberto (o convite é conferido pela API)");
} else {
  report(false, "configuração do login", "defina SUPABASE_PUBLISHABLE_KEY para conferir");
}

// 3. Um token de verdade passa pelo mesmo verificador da API.
// Sem token pronto, entra com o usuário de teste do painel (SUPABASE_TEST_EMAIL e SUPABASE_TEST_PASSWORD).
async function tokenOfTestUser(): Promise<string | undefined> {
  const email = process.env.SUPABASE_TEST_EMAIL;
  const password = process.env.SUPABASE_TEST_PASSWORD;
  if (!email || !password || !publishable) return undefined;
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: publishable, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { access_token?: string };
  report(res.ok && !!body.access_token, "login do usuário de teste por e-mail e senha", res.ok ? "" : `HTTP ${res.status}`);
  return body.access_token;
}

const token = process.env.SUPABASE_TEST_TOKEN ?? (await tokenOfTestUser());
if (token) {
  try {
    const identity = await authVerifierFromEnv(new SystemClock()).verify(token);
    report(true, "token de teste aceito pelo SupabaseAuthVerifier", mask(identity.email));
    report(identity.emailVerified, "o token traz user_metadata.email_verified verdadeiro (sem ele, a API recusa com email_not_confirmed)");
    console.log(`     último login: ${identity.authenticatedAt.toISOString()}; vence: ${identity.expiresAt.toISOString()}`);
  } catch (error) {
    report(false, "token de teste aceito pelo SupabaseAuthVerifier", (error as Error).message);
  }
} else {
  console.log("     (sem SUPABASE_TEST_TOKEN nem SUPABASE_TEST_EMAIL e SUPABASE_TEST_PASSWORD: o token de teste não foi conferido)");
}

// 4. Opcional: apagar o usuário de teste, conferindo a chave de serviço.
const subject = process.env.SUPABASE_CHECK_DELETE_SUBJECT;
if (subject) {
  try {
    await authVerifierFromEnv(new SystemClock()).deleteIdentity(subject);
    report(true, "usuário de teste apagado pela API de administração");
  } catch (error) {
    report(false, "usuário de teste apagado pela API de administração", (error as Error).message);
  }
}

console.log(failures === 0 ? "\nTudo certo." : `\n${failures} ponto(s) a acertar no painel do Supabase.`);
process.exit(failures === 0 ? 0 : 1);
