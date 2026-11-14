import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// O ensaio completo roda pelo vitest só para ter o SWC (metadados de decorador do Nest); não faz parte do `npm test`.
export default defineConfig({
  test: { include: ["ensaio/*.ensaio.ts"], testTimeout: 0, hookTimeout: 0 },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
