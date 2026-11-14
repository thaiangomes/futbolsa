/**
 * Guardas do ensaio (P1 do Plano do ensaio): o servidor de teste nunca liga num banco hospedado
 * e nunca nasce num ambiente de produção.
 */

/** Hospedagens de banco que o ensaio recusa: o plano grátis é pequeno e o dado é de verdade. */
const BANCOS_RECUSADOS = [/supabase\.(co|com)$/i, /\.neon\.tech$/i, /rds\.amazonaws\.com$/i];

/** Só servidor local ou do CI: localhost, 127.0.0.1, ::1 ou um serviço de contêiner sem ponto no nome. */
export function recusarBancoNaoLocal(url: string): void {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (BANCOS_RECUSADOS.some((r) => r.test(host))) {
    throw new Error(`O ensaio se recusa a ligar num banco hospedado (${host}). Use o Postgres local.`);
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1" || !host.includes(".");
  if (!local) throw new Error(`O ensaio só liga em banco local ou de contêiner do CI, não em ${host}.`);
}

/** O servidor de teste não sobe com `NODE_ENV=production`. */
export function recusarProducao(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") throw new Error("O servidor do ensaio não roda com NODE_ENV=production.");
}
