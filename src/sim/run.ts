/**
 * Roda a simulação de uma temporada e grava o resultado em sim-output/.
 *
 * Uso:
 *   npm run sim -- [--data data/brasileirao-2025.json] [--seed 1]
 *                  [--bots 25] [--ponto 10] [--recompra 0] [--traders 0] [--acerto 0.3,0.5,0.7] [--captura 0] [--extras analista=25] [--copas libertadores,copa-do-brasil,sul-americana] [--torcida-copa] [--ipo-copas] [--out sim-output]
 *
 * --bots   bots por perfil (4 perfis)
 * --ponto  dividendo por ponto, em centavos (padrão 10 = R$ 0,10)
 * --ancora preço de referência do formador de mercado: lastTrade (padrão, o
 *          último negócio, inclusive com a casa) ou peer (só negócios entre
 *          jogadores; os negócios com a casa deixam de mexer no preço)
 * --recompra múltiplo dos dividendos da temporada que a casa paga por ação ao
 *          recomprar todas no fim (padrão 0 = sem recompra)
 * --traders quantos bots do perfil trader, além dos 4 perfis (padrão 0)
 * --acerto  taxas de acerto dos traders, em rodízio (padrão: palpite pela campanha)
 * --captura quantos bots de captura de dividendo, além dos outros (padrão 0)
 * --extras  outros perfis fora da mistura padrão, como analista=25,concentrador=25
 * --copas   copas que pagam dividendos: libertadores, copa-do-brasil, sul-americana
 * --torcida-copa  torcedores compram o próprio time antes dos mata-matas de copa
 * --ipo-copas  a faixa do IPO soma os dividendos de copa esperados (com a recompra)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSeason } from "../data/season.js";
import { BRASILEIRAO_A, COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA, type CupRules } from "../engine/dividends.js";
import type { Match } from "../engine/types.js";
import { DEFAULT_MARKET_MAKER } from "../engine/marketMaker.js";
import { renderReport } from "./report.js";
import { simulate } from "./simulate.js";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: "data/brasileirao-2025.json" },
    seed: { type: "string", default: "1" },
    bots: { type: "string", default: "25" },
    ponto: { type: "string", default: String(BRASILEIRAO_A.perPoint) },
    out: { type: "string", default: "sim-output" },
    ancora: { type: "string", default: DEFAULT_MARKET_MAKER.anchor },
    recompra: { type: "string", default: "0" },
    traders: { type: "string", default: "0" },
    captura: { type: "string", default: "0" },
    extras: { type: "string", default: "" },
    copas: { type: "string", default: "" },
    "torcida-copa": { type: "boolean", default: false },
    "ipo-copas": { type: "boolean", default: false },
    acerto: { type: "string", default: "" },
  },
});

const season = loadSeason(values.data!);
const perBot = Number(values.bots);
const traders = Number(values.traders);
// Copas: os jogos ficam em data/<copa>-<ano>.json.
const CUP_RULES: Record<string, CupRules> = {
  libertadores: LIBERTADORES,
  "copa-do-brasil": COPA_DO_BRASIL,
  "sul-americana": SULAMERICANA,
};
const cups = (values.copas ?? "").split(",").filter(Boolean).map((c) => {
  const rules = CUP_RULES[c];
  if (!rules) throw new Error(`Copa desconhecida: ${c}`);
  const file = JSON.parse(readFileSync(`data/${c}-${season.season}.json`, "utf8")) as { matches: Match[] };
  return { matches: file.matches, rules };
});
// Perfis fora da mistura padrão, como analista=25,concentrador=25.
const extras = Object.fromEntries((values.extras ?? "").split(",").filter(Boolean).map((p) => {
  const [k, n] = p.split("=");
  return [k!, Number(n)];
}));
const acerto = values.acerto ? values.acerto.split(",").map(Number) : [];
const perPoint = Number(values.ponto);
const scale = perPoint / BRASILEIRAO_A.perPoint;

const started = Date.now();
const result = simulate(season, {
  seed: Number(values.seed),
  bots: { dividendos: perBot, momentum: perBot, torcedor: perBot, aleatorio: perBot, trader: traders, captura: Number(values.captura), analista: 0, concentrador: 0, antecipador: 0, ...extras },
  // O dividendo da colocação final acompanha a mesma escala do dividendo por ponto.
  rules: { perPoint, placement: BRASILEIRAO_A.placement.map((v) => Math.round(v * scale)) },
  marketMaker: { ...DEFAULT_MARKET_MAKER, anchor: values.ancora === "peer" ? "peer" : "lastTrade" },
  buyback: Number(values.recompra),
  traderHitRates: acerto,
  cups,
  fanCupHype: values["torcida-copa"],
  ipoCups: values["ipo-copas"],
});
const report = renderReport(result);

mkdirSync(values.out!, { recursive: true });
const tag = `${season.season}-semente${values.seed}-ponto${perPoint}-${values.ancora}-recompra${values.recompra}${traders ? `-traders${traders}` : ""}${acerto.length ? `-acerto${acerto.join("_")}` : ""}${values.captura !== "0" ? `-captura${values.captura}` : ""}${values.extras ? `-${values.extras.replace(/[=,]/g, "")}` : ""}${cups.length ? `-copas${values.copas!.replace(/,/g, "_")}` : ""}${values["torcida-copa"] ? "-torcidacopa" : ""}${values["ipo-copas"] ? "-ipocopas" : ""}`;
writeFileSync(join(values.out!, `resultado-${tag}.json`), JSON.stringify(result, null, 2));
writeFileSync(join(values.out!, `resumo-${tag}.md`), report);
console.log(report);
console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s; arquivos em ${values.out}/)`);
