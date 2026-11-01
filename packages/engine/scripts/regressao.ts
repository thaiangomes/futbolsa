/**
 * Confere a simulação contra as referências de regressão (mesmos negócios e
 * mesmo resultado com a mesma semente) ou, com --gravar, regrava as referências.
 *
 * Uso (da pasta packages/engine, ou `npm run sim:regressao` na raiz):
 *   npm run sim:regressao [-- --gravar] [-- --so A-mini-fair,B-mini-peer]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { fingerprint, readReference, referencePath, SCENARIOS } from "../src/sim/regressao.js";

const { values } = parseArgs({
  options: {
    gravar: { type: "boolean", default: false },
    so: { type: "string", default: "" },
  },
});

const only = values.so ? values.so.split(",") : [];
let failed = 0;
for (const s of SCENARIOS.filter((s) => only.length === 0 || only.includes(s.name))) {
  const started = Date.now();
  const got = fingerprint(s.name, s.run);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (values.gravar) {
    mkdirSync(dirname(referencePath(s.name)), { recursive: true });
    writeFileSync(referencePath(s.name), JSON.stringify(got, null, 2) + "\n");
    console.log(`gravado  ${s.name}: ${got.trades} negócios (${secs} s)`);
    continue;
  }
  const want = readReference(s.name);
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failed++;
  console.log(`${same ? "igual    " : "DIFERENTE"} ${s.name}: ${got.trades} negócios (referência ${want.trades}) (${secs} s)`);
}
if (failed) {
  console.error(`${failed} cenário(s) diferente(s) da referência.`);
  process.exit(1);
}
