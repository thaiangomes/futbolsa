import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { comparar, extrairMedidas, lerLimites, referenciaExata, relatorioMarkdown } from "./comparar.js";
import { criarServidorEnsaio } from "./servidor.js";

/**
 * Compara um banco de ensaio já rodado (mantido com ENSAIO_MANTER=1) com a simulação. ENSAIO_BANCO = nome do banco,
 * ENSAIO_SAIDA = pasta do relatório. Serve para refazer a comparação sem rodar o ensaio de novo.
 */
it("comparação do banco do ensaio com a simulação", async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${process.env.ENSAIO_BANCO}`;
  const servidor = await criarServidorEnsaio({ databaseUrl: url.toString(), inicio: new Date("2026-02-04T00:00:00Z"), poolSize: 3 });
  try {
    const lote = JSON.parse(readFileSync(new URL("./referencia/lote-regras-do-jogo.json", import.meta.url), "utf8"));
    const medidas = await extrairMedidas(servidor, { seasonId: 1 } as never);
    const linhas = comparar(medidas, referenciaExata(), lote, lerLimites());
    const pasta = process.env.ENSAIO_SAIDA ?? "ensaio-saida";
    mkdirSync(pasta, { recursive: true });
    writeFileSync(join(pasta, "comparacao.md"), relatorioMarkdown(linhas));
    writeFileSync(join(pasta, "medidas.json"), JSON.stringify(medidas, null, 2));
    console.log(`COMPARACAO ${linhas.filter((l) => !l.ok).length} diferenças em ${linhas.length} medidas`);
  } finally {
    await servidor.fechar();
  }
}, 600_000);
