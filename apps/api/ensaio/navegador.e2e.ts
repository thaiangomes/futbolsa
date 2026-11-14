/**
 * Processo do servidor do navegador, subido pelo Playwright (`webServer` de `apps/web/e2e/playwright.config.ts`) por
 * `npm run e2e:servidor -w @futbolsa/api`. Roda pelo vitest só para ter o SWC (metadados de decorador do Nest).
 * Variáveis: TEST_DATABASE_URL (Postgres local), E2E_SITE (pasta do site de teste).
 */
import { resolve } from "node:path";
import { it } from "vitest";
import { PORTAS_PADRAO, subirNavegador } from "./navegador.js";

it("servidor do navegador", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("Defina TEST_DATABASE_URL (Postgres local).");
  const nav = await subirNavegador({
    databaseUrl,
    pastaDoSite: resolve(process.env.E2E_SITE ?? "../web/out-e2e"),
    portaApi: Number(process.env.E2E_PORTA_API ?? PORTAS_PADRAO.api),
    portaSite: Number(process.env.E2E_PORTA_SITE ?? PORTAS_PADRAO.site),
    portaControle: Number(process.env.E2E_PORTA_CONTROLE ?? PORTAS_PADRAO.controle),
  });
  console.log(`E2E pronto: api ${nav.servidor.url}, controle ${nav.controleUrl}`);
  await new Promise(() => undefined);
}, 0);
