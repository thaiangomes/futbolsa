/**
 * Roda a simulação de uma temporada e grava o resultado em sim-output/.
 *
 * Uso:
 *   npm run sim -- [--data data/brasileirao-2025.json] [--seed 2025]
 *                  [--bots 25] [--ponto 10] [--out sim-output]
 *
 * --bots   bots por perfil (4 perfis)
 * --ponto  dividendo por ponto, em centavos (padrão 10 = R$ 0,10)
 * --ancora preço de referência do formador de mercado: lastTrade (padrão, o
 *          último negócio, inclusive com a casa) ou peer (só negócios entre
 *          jogadores; os negócios com a casa deixam de mexer no preço)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSeason } from "../data/season.js";
import { BRASILEIRAO_A } from "../engine/dividends.js";
import { DEFAULT_MARKET_MAKER } from "../engine/marketMaker.js";
import { renderReport } from "./report.js";
import { simulate } from "./simulate.js";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: "data/brasileirao-2025.json" },
    seed: { type: "string", default: "2025" },
    bots: { type: "string", default: "25" },
    ponto: { type: "string", default: String(BRASILEIRAO_A.perPoint) },
    out: { type: "string", default: "sim-output" },
    ancora: { type: "string", default: DEFAULT_MARKET_MAKER.anchor },
  },
});

const season = loadSeason(values.data!);
const perBot = Number(values.bots);
const perPoint = Number(values.ponto);
const scale = perPoint / BRASILEIRAO_A.perPoint;

const started = Date.now();
const result = simulate(season, {
  seed: Number(values.seed),
  bots: { dividendos: perBot, momentum: perBot, torcedor: perBot, aleatorio: perBot },
  // O dividendo da colocação final acompanha a mesma escala do dividendo por ponto.
  rules: { perPoint, placement: BRASILEIRAO_A.placement.map((v) => Math.round(v * scale)) },
  marketMaker: { ...DEFAULT_MARKET_MAKER, anchor: values.ancora === "peer" ? "peer" : "lastTrade" },
});
const report = renderReport(result);

mkdirSync(values.out!, { recursive: true });
const tag = `${season.season}-semente${values.seed}-ponto${perPoint}-${values.ancora}`;
writeFileSync(join(values.out!, `resultado-${tag}.json`), JSON.stringify(result, null, 2));
writeFileSync(join(values.out!, `resumo-${tag}.md`), report);
console.log(report);
console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s; arquivos em ${values.out}/)`);
