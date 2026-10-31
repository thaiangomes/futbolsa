import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// O vitest (esbuild) não gera os metadados de decorador que o Nest usa para injetar
// dependências; o SWC gera.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
