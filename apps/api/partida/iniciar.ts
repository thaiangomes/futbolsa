/**
 * `npm run partida -- [--escala 0,2] [--apelido jogador] [--aprovar-sozinho]`: traduz as opções para as variáveis do servidor
 * (`servidor.partida.ts`) e o sobe pelo vitest. Precisa de TEST_DATABASE_URL (Postgres local) e do site construído
 * (`npm run partida:site -w @futbolsa/web`).
 */
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const valor = (nome: string): string | undefined => {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const env: NodeJS.ProcessEnv = { ...process.env };
if (valor("escala")) env.PARTIDA_ESCALA = valor("escala");
if (valor("apelido")) env.PARTIDA_APELIDO = valor("apelido");
if (valor("site")) env.PARTIDA_SITE = valor("site");
if (args.includes("--aprovar-sozinho")) env.PARTIDA_APROVAR_SOZINHO = "1";
const filho = spawn("npx", ["vitest", "run", "--config", "vitest.partida.config.ts", "partida/servidor.partida.ts"], { stdio: "inherit", env, shell: true });
filho.on("exit", (codigo) => process.exit(codigo ?? 1));
