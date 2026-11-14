import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright contra o Supabase de verdade (T23). Só roda por `npm run e2e:supabase`, que constrói o site com o login real, sobe a
 * API de verdade e passa as variáveis abaixo. Nunca entra no `npm run e2e` nem no CI: o `testIgnore` da outra configuração o exclui.
 */
const site = process.env.E2E_SUPABASE_SITE;
if (!site || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Rode por `npm run e2e:supabase -w @futbolsa/web` (ele prepara o ambiente). Nunca no CI.");
}

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: "../../test-results-supabase",
  // sem vídeo, rastro nem captura: a tela de login e os links de nova senha não podem ir parar em arquivo
  use: { baseURL: site, locale: "pt-BR", trace: "off", video: "off", screenshot: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
