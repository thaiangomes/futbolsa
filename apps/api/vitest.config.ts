import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// O vitest (esbuild) não gera os metadados de decorador que o Nest usa para injetar
// dependências; o SWC gera.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // os testes do banco rodam contra o Postgres do docker compose (test/support/db.ts)
    globalSetup: ["test/support/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
