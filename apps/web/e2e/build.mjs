// Constrói o site de teste (`out-e2e/`): o mesmo site, com o login falso e a API nos endereços fixos do servidor do navegador.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("..", import.meta.url));
// `--api <endereço>` e `--saida <pasta>` (a partida de teste constrói o mesmo site para a API dela: `npm run partida:site`)
const arg = (nome) => {
  const i = process.argv.lastIndexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// O login falso só entra nestas pastas (next.config.mjs): em outra, o site sai com o login real e ninguém consegue entrar.
const saida = arg("saida") ?? "out-e2e";
if (!["out-e2e", "out-partida"].includes(saida)) {
  console.error(`A pasta de saída "${saida}" não leva o login falso: use out-e2e ou out-partida.`);
  process.exit(1);
}
// A API do site de teste é sempre local (127.0.0.1) ou de rede privada (192.168.x, 10.x, 172.16 a 31.x): nunca endereço público.
const api = arg("api") ?? process.env.E2E_API_URL ?? "http://127.0.0.1:3100";
const host = (() => { try { return new URL(api).hostname; } catch { return ""; } })();
const privado = (h) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h); if (!m) return false; const [a, b] = [Number(m[1]), Number(m[2])]; return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); };
if (host !== "127.0.0.1" && host !== "localhost" && !privado(host)) {
  console.error(`A API do site de teste tem de ser local ou de rede privada, não ${api}.`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ["../../node_modules/next/dist/bin/next", "build"], {
  cwd: raiz,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_AUTH_CLIENT: "fake",
    NEXT_PUBLIC_API_URL: api,
    NEXT_DIST_DIR: saida,
  },
});
process.exit(r.status ?? 1);
