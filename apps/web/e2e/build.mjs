// Constrói o site de teste (`out-e2e/`): o mesmo site, com o login falso e a API nos endereços fixos do servidor do navegador.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("..", import.meta.url));
// `--api <endereço>` e `--saida <pasta>` (a partida de teste constrói o mesmo site para a API dela: `npm run partida:site`)
const arg = (nome) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
// O login falso só entra nestas pastas (next.config.mjs): em outra, o site sai com o login real e ninguém consegue entrar.
const saida = arg("saida") ?? "out-e2e";
if (!["out-e2e", "out-partida"].includes(saida)) {
  console.error(`A pasta de saída "${saida}" não leva o login falso: use out-e2e ou out-partida.`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ["../../node_modules/next/dist/bin/next", "build"], {
  cwd: raiz,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_AUTH_CLIENT: "fake",
    NEXT_PUBLIC_API_URL: arg("api") ?? process.env.E2E_API_URL ?? "http://127.0.0.1:3100",
    NEXT_DIST_DIR: saida,
  },
});
process.exit(r.status ?? 1);
