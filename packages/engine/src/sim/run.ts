/**
 * Roda a simulação de uma temporada e grava o resultado em sim-output/.
 *
 * Uso:
 *   npm run sim -- [--data data/brasileirao-2025.json] [--seed 1]
 *                  [--bots 25] [--ponto 10] [--recompra 1.5] [--traders 50] [--acerto 0.3,0.5,0.7] [--captura 25] [--extras analista=25,concentrador=25,antecipador=25] [--copas libertadores,copa-do-brasil,sul-americana] [--torcida-copa] [--no-ipo-copas] [--faixa 0.4] [--out sim-output]
 *
 * --bots   bots por perfil (4 perfis)
 * --ponto  dividendo por ponto, em centavos (padrão 10 = R$ 0,10)
 * --ancora preço de referência do formador de mercado: fair (padrão, o valor
 *          justo da casa com faixa de 10%; negócios não mexem na cotação),
 *          lastTrade (o último negócio, inclusive com a casa, spread de 2%) ou peer (só negócios entre
 *          jogadores; os negócios com a casa deixam de mexer no preço)
 * --recompra múltiplo dos dividendos da temporada que a casa paga por ação ao
 *          recomprar todas no fim (padrão 1.5; 0 = sem recompra)
 * --traders quantos bots do perfil trader, além dos 4 perfis (padrão 50)
 * --acerto  taxas de acerto dos traders, em rodízio (padrão 0.3,0.5,0.7; vazio: palpite pela campanha)
 * --captura quantos bots de captura de dividendo, além dos outros (padrão 25)
 * --extras  outros perfis: analista, concentrador e antecipador (padrão 25 de cada)
 * --copas   copas que pagam dividendos: libertadores, copa-do-brasil, sul-americana
 *          (padrão as três; --copas= para nenhuma)
 * --torcida-copa  torcedores compram o próprio time antes dos mata-matas de copa
 * --ipo-copas  a faixa do IPO soma os dividendos de copa esperados (com a recompra);
 *          ligado por padrão, --no-ipo-copas desliga
 * --cenarios  quantos cenários o valor justo dos bots sorteia (vagas, rebaixamento e copas; 0 = a conta de sempre, padrão)
 * --regras-do-jogo  lote do formador, quantidade proporcional, ordem contra si mesmo recusada e faixa de 20% (P5 do Plano do ensaio)
 * --faixa  largura da faixa do IPO para cada lado do centro (padrão 0.4 = 60% a 140%)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSeason } from "../data/season.js";
import { BRASILEIRAO_A, COPA_DO_BRASIL, LIBERTADORES, scaleLeagueRules, SULAMERICANA, type CupRules } from "../engine/dividends.js";
import type { Match } from "../engine/types.js";
import { DEFAULT_MARKET_MAKER, LAST_TRADE_MARKET_MAKER } from "../engine/marketMaker.js";
import { renderReport } from "./report.js";
import { simulate } from "./simulate.js";

const { values } = parseArgs({
  allowNegative: true,
  options: {
    data: { type: "string", default: "data/brasileirao-2025.json" },
    seed: { type: "string", default: "1" },
    bots: { type: "string", default: "25" },
    ponto: { type: "string", default: String(BRASILEIRAO_A.perPoint) },
    out: { type: "string", default: "sim-output" },
    ancora: { type: "string", default: DEFAULT_MARKET_MAKER.anchor },
    recompra: { type: "string", default: "1.5" },
    traders: { type: "string", default: "50" },
    captura: { type: "string", default: "25" },
    extras: { type: "string", default: "analista=25,concentrador=25,antecipador=25" },
    copas: { type: "string", default: "libertadores,copa-do-brasil,sul-americana" },
    "torcida-copa": { type: "boolean", default: false },
    "ipo-copas": { type: "boolean", default: true },
    acerto: { type: "string", default: "0.3,0.5,0.7" },
    faixa: { type: "string", default: "0.4" },
    "regras-do-jogo": { type: "boolean", default: false },
    cenarios: { type: "string", default: "0" },
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
  rules: { ...scaleLeagueRules(BRASILEIRAO_A, scale), perPoint },
  marketMaker: values.ancora === "fair" ? DEFAULT_MARKET_MAKER : { ...LAST_TRADE_MARKET_MAKER, anchor: values.ancora === "peer" ? "peer" : "lastTrade" },
  buyback: Number(values.recompra),
  traderHitRates: acerto,
  cups,
  fanCupHype: values["torcida-copa"],
  ipoCups: values["ipo-copas"],
  bandWidth: Number(values.faixa),
  gameRules: values["regras-do-jogo"],
  ...(Number(values.cenarios) > 0 ? { scenarios: Number(values.cenarios) } : {}),
});
const report = renderReport(result);

mkdirSync(values.out!, { recursive: true });
const tag = `${season.season}-semente${values.seed}-ponto${perPoint}-${values.ancora}-recompra${values.recompra}${traders ? `-traders${traders}` : ""}${acerto.length ? `-acerto${acerto.join("_")}` : ""}${values.captura !== "0" ? `-captura${values.captura}` : ""}${values.extras ? `-${values.extras.replace(/[=,]/g, "")}` : ""}${cups.length ? `-copas${values.copas!.replace(/,/g, "_")}` : ""}${values["torcida-copa"] ? "-torcidacopa" : ""}${values["ipo-copas"] ? "-ipocopas" : ""}${values["regras-do-jogo"] ? "-regras" : ""}${Number(values.cenarios) > 0 ? `-cenarios${values.cenarios}` : ""}${values.faixa !== "0.4" ? `-faixa${values.faixa}` : ""}`;
writeFileSync(join(values.out!, `resultado-${tag}.json`), JSON.stringify(result, null, 2));
writeFileSync(join(values.out!, `resumo-${tag}.md`), report);
console.log(report);
console.log(`(${((Date.now() - started) / 1000).toFixed(1)} s; arquivos em ${values.out}/)`);
