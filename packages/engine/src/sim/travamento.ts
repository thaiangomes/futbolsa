/**
 * Rodada Z de Calibração (2026-11-15): clubes que ficam sem negócio quando o preço abre bem acima do valor justo.
 * Roda a simulação na escala e no ritmo da partida de teste (150 bots, paradas de 15 minutos, chance de 2,1%,
 * regras do jogo) em várias sementes e mede negócios, distância ao valor justo, clubes parados, leilões
 * (negócios fora do túnel de 10%), resultado da casa e retorno por perfil.
 *
 * Uso: npm run sim:travamento -- [--sementes 5] [--variante base|decai|margem|ativos|decai+ativos] [--premio 1.6]
 *                                [--passo 0.25] [--cresce 0.025] [--bots 15]
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadSeason } from "../data/season.js";
import { BRASILEIRAO_A_2026 as BRASILEIRAO_A, COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA } from "../engine/dividends.js";
import { DEFAULT_MARKET_MAKER } from "../engine/marketMaker.js";
import type { Match } from "../engine/types.js";
import { PROFILES } from "./bots.js";
import { simulate, type SimConfig } from "./simulate.js";

const { values } = parseArgs({
  options: {
    sementes: { type: "string", default: "5" },
    inicial: { type: "string", default: "1" },
    variante: { type: "string", default: "base" },
    premio: { type: "string", default: "1.6" },
    passo: { type: "string", default: "0.25" },
    cresce: { type: "string", default: "0.025" },
    bots: { type: "string", default: "15" },
    data: { type: "string", default: "data/brasileirao-2025.json" },
  },
});

const DAY = 24 * 60 * 60 * 1000;
const season = loadSeason(values.data!);
const cups = (["libertadores", "copa-do-brasil", "sul-americana"] as const).map((c) => {
  const rules = { libertadores: LIBERTADORES, "copa-do-brasil": COPA_DO_BRASIL, "sul-americana": SULAMERICANA }[c];
  const file = JSON.parse(readFileSync(`data/${c}-${season.season}.json`, "utf8")) as { matches: Match[] };
  return { matches: file.matches, rules };
});
const n = Number(values.bots);
const stepHours = Number(values.passo);
const variant = values.variante!;
const slow = variant.includes("ativos") ? 4 : 1; // bots 4× mais ativos
const config = (seed: number): Partial<SimConfig> => ({
  seed,
  bots: { dividendos: n, momentum: n, torcedor: n, aleatorio: n, trader: 2 * n, captura: n, analista: n, concentrador: n, antecipador: n },
  rules: { perPoint: BRASILEIRAO_A.perPoint, placement: [...BRASILEIRAO_A.placement] },
  marketMaker: DEFAULT_MARKET_MAKER,
  buyback: 1.5,
  traderHitRates: [0.3, 0.5, 0.7],
  cups,
  ipoCups: true,
  bandWidth: 0.4,
  gameRules: true,
  stepHours,
  activity: Math.min(1, ((0.25 * stepHours) / 3) * slow),
  startPremium: Number(values.premio) > 1 ? Number(values.premio) : undefined,
  referenceDecay: variant.includes("decai"),
  referenceGapBp: variant.includes("gap20") ? 2000 : undefined,
  bandCap: variant.includes("cap"),
  marginGrowth: variant.includes("margem") ? Number(values.cresce) : undefined,
});

interface Row { seed: number; tradesPerDay: number; zeroDays: number; stuck: number; gapAll: number; gapEarly: number; breaches: number; houseTrades: number; house: number; refused: number; ret: Record<string, number>; }
const rows: Row[] = [];
for (let seed = Number(values.inicial); seed < Number(values.inicial) + Number(values.sementes); seed++) {
  const lastAt = new Map<string, number>();
  const dayRef = new Map<string, number>();
  const lastPrice = new Map<string, number>();
  const tradeDays = new Set<number>();
  let breaches = 0;
  let trades = 0;
  let houseTrades = 0;
  let stuckSamples = 0, stuckHits = 0, gapSum = 0, gapN = 0, gapEarlySum = 0, gapEarlyN = 0;
  let lastDay = -1;
  let firstDay = 0;
  const result = simulate(season, config(seed), {
    onTrade: (t) => {
      trades++;
      if (t.buyerId === "tesouraria" || t.sellerId === "tesouraria") houseTrades++;
      const day = Math.floor(t.at / DAY);
      tradeDays.add(day);
      const ref = dayRef.get(t.clubId) ?? t.price;
      if (Math.abs(t.price / ref - 1) > 0.1) breaches++;
      lastAt.set(t.clubId, t.at);
      lastPrice.set(t.clubId, t.price);
    },
    onStep: (t, view, clubIds) => {
      const day = Math.floor(t / DAY);
      if (day === lastDay) return;
      lastDay = day;
      if (!firstDay) firstDay = day;
      for (const id of clubIds) {
        dayRef.set(id, view.price(id));
        const fair = view.fairValue(id);
        if (fair < 200) continue;
        stuckSamples++;
        if (t - (lastAt.get(id) ?? 0) >= 7 * DAY) stuckHits++;
        const gap = Math.abs(view.price(id) / fair - 1);
        gapSum += gap; gapN++;
        if (day - firstDay < 60) { gapEarlySum += gap; gapEarlyN++; }
      }
    },
  });
  const days = Math.max(1, Object.values(result.dailyPrices)[0]!.length);
  const ret: Record<string, number> = {};
  for (const p of PROFILES) {
    const bs = result.bots.filter((b) => b.profile === p);
    ret[p] = bs.reduce((s, b) => s + (b.finalWorth / result.config.initialCash - 1), 0) / bs.length;
  }
  rows.push({
    seed,
    tradesPerDay: trades / days,
    zeroDays: days - tradeDays.size,
    stuck: stuckHits / Math.max(1, stuckSamples),
    gapAll: gapSum / Math.max(1, gapN),
    gapEarly: gapEarlySum / Math.max(1, gapEarlyN),
    breaches,
    houseTrades,
    house: (result.treasury.finalCash + result.treasury.finalSharesValue - result.treasury.startCash) / 100,
    refused: result.refused?.price_out_of_band ?? 0,
    ret,
  });
  console.error(`semente ${seed} pronta`);
}
const avg = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
console.log(`\n## ${variant} | prêmio ${values.premio} | passo ${stepHours} h | ${rows.length} sementes | ${n * 10} bots`);
console.log("| Semente | Negócios/dia | Dias sem negócio | Clube-dias parados (7d+) | Distância ao justo (ano / 60 dias) | Fora do túnel | Com a casa | Resultado da casa (R$) | Recusadas pela faixa |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.seed} | ${r.tradesPerDay.toFixed(1)} | ${r.zeroDays} | ${pct(r.stuck)} | ${pct(r.gapAll)} / ${pct(r.gapEarly)} | ${r.breaches} | ${r.houseTrades} | ${r.house.toFixed(0)} | ${r.refused} |`);
console.log(`| **Média** | ${avg((r) => r.tradesPerDay).toFixed(1)} | ${avg((r) => r.zeroDays).toFixed(1)} | ${pct(avg((r) => r.stuck))} | ${pct(avg((r) => r.gapAll))} / ${pct(avg((r) => r.gapEarly))} | ${avg((r) => r.breaches).toFixed(0)} | ${avg((r) => r.houseTrades).toFixed(0)} | ${avg((r) => r.house).toFixed(0)} | ${avg((r) => r.refused).toFixed(0)} |`);
console.log(`Retorno médio por perfil: ${PROFILES.map((p) => `${p} ${pct(avg((r) => r.ret[p]!))}`).join(" · ")}`);
