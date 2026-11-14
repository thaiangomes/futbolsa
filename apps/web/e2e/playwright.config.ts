import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright do FutBolsa (T19, P8 do Plano do ensaio, carga e testes no navegador): só o Chromium, um trabalhador de cada vez
 * (8 GB de memória), vídeo e rastro só nas falhas. O `webServer` sobe a API, o banco `futbolsa_e2e` e o site de teste
 * (`out-e2e/`, construído por `npm run e2e:build`) num processo só, com a porta de controle do relógio e dos cenários.
 * Precisa de `TEST_DATABASE_URL` (um Postgres local ou o do CI).
 */
export const PORTA_SITE = 3101;
export const PORTA_CONTROLE = 3102;

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("Defina TEST_DATABASE_URL (Postgres local ou o do CI): o servidor do navegador cria o banco futbolsa_e2e nele.");
}

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  testIgnore: "supabase/**",
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]],
  outputDir: "../test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORTA_SITE}`,
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run e2e:servidor -w @futbolsa/api",
    cwd: "../../..",
    url: `http://127.0.0.1:${PORTA_CONTROLE}/hora`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
