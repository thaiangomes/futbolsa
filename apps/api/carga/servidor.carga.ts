/**
 * O processo do servidor da carga (T16), separado do gerador: `npm run carga` o inicia pelo vitest (que traz o SWC para o Nest) e
 * lê o endereço dele no arquivo que `CARGA_PRONTO` aponta. Fica de pé até o gerador encerrar o processo.
 * Variáveis: CARGA_DATABASE_URL (o banco, já migrado), CARGA_PRONTO (arquivo de saída), CARGA_POOL (conexões do banco, 30).
 */
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { subirServidorDeCarga } from "./servidor.js";

it("servidor da carga", async () => {
  const databaseUrl = process.env.CARGA_DATABASE_URL;
  const pronto = process.env.CARGA_PRONTO;
  if (!databaseUrl || !pronto) throw new Error("Defina CARGA_DATABASE_URL e CARGA_PRONTO.");
  const servidor = await subirServidorDeCarga({ databaseUrl, poolSize: Number(process.env.CARGA_POOL ?? 30) });
  writeFileSync(pronto, JSON.stringify({ apiUrl: servidor.apiUrl, controleUrl: servidor.controleUrl }));
  await new Promise(() => undefined);
});
