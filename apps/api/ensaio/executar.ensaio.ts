/**
 * Execução do ensaio completo (T13), chamada por `npm run ensaio -w @futbolsa/api`. Opções por variável de ambiente (o vitest não
 * repassa argumentos): ENSAIO_ESCALA (0.2), ENSAIO_SEMENTE (1), ENSAIO_CURTA (rodadas; vazio = temporada inteira),
 * ENSAIO_JOGADORES (6), ENSAIO_TICK (180), ENSAIO_ATE_DIAS (parar N dias depois da abertura da negociação), ENSAIO_MANTER (1), ENSAIO_SAIDA (pasta, padrão ensaio-saida).
 * Precisa de TEST_DATABASE_URL (Postgres local; o ensaio cria o banco dele ao lado e o apaga no fim).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { executarEnsaio } from "./ensaio.js";

it("ensaio da temporada de 2025", async () => {
  const urlBase = process.env.TEST_DATABASE_URL;
  if (!urlBase) throw new Error("Defina TEST_DATABASE_URL (Postgres local).");
  const e = process.env;
  const { resultado, fechar } = await executarEnsaio({
    urlBase,
    escala: Number(e.ENSAIO_ESCALA ?? 0.2),
    semente: Number(e.ENSAIO_SEMENTE ?? 1),
    curta: e.ENSAIO_CURTA ? { rodadas: Number(e.ENSAIO_CURTA) } : undefined,
    jogadores: Number(e.ENSAIO_JOGADORES ?? 6),
    ateDiasDepoisDaAbertura: e.ENSAIO_ATE_DIAS ? Number(e.ENSAIO_ATE_DIAS) : undefined,
    tickMinutes: Number(e.ENSAIO_TICK ?? 180),
    manterBanco: e.ENSAIO_MANTER === "1",
    log: (l) => console.log(l),
  });
  try {
    const pasta = e.ENSAIO_SAIDA ?? "ensaio-saida";
    mkdirSync(pasta, { recursive: true });
    const arquivo = join(pasta, `ensaio-${new Date().toISOString().slice(0, 10)}.json`);
    writeFileSync(arquivo, JSON.stringify(resultado, null, 2));
    console.log(JSON.stringify(resultado, null, 2));
    console.log(`(relatório em ${arquivo})`);
  } finally {
    await fechar();
  }
});
