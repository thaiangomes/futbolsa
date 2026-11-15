// Constrói o site de teste (`out-e2e/`): o mesmo site, com o login falso e a API nos endereços fixos do servidor do navegador.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = fileURLToPath(new URL("..", import.meta.url));
const r = spawnSync(process.execPath, ["../../node_modules/next/dist/bin/next", "build"], {
  cwd: raiz,
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_AUTH_CLIENT: "fake",
    NEXT_PUBLIC_API_URL: process.env.E2E_API_URL ?? "http://127.0.0.1:3100",
    NEXT_DIST_DIR: "out-e2e",
  },
});
process.exit(r.status ?? 1);
