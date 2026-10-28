/**
 * Roda a mesma simulação em várias sementes e resume o que muda entre elas,
 * para testar uma hipótese de calibração de cada vez contra a linha de base.
 *
 * Uso:
 *   npm run sim:lote -- [--sementes 10] [--ponto 10] [--ancora lastTrade] [--recompra 0] [--bots 25]
 *                       [--data data/brasileirao-2025.json] [--out sim-output]
 *
 * --sementes  quantas sementes, de 1 até esse número (padrão 10)
 * As outras opções são as mesmas de `npm run sim`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSeason } from "../data/season.js";
import { BRASILEIRAO_A } from "../engine/dividends.js";
import { DEFAULT_MARKET_MAKER } from "../engine/marketMaker.js";
import { PROFILES, type BotProfile } from "./bots.js";
import { checkpointStats } from "./report.js";
import { simulate, type SimResult } from "./simulate.js";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: "data/brasileirao-2025.json" },
    sementes: { type: "string", default: "10" },
    bots: { type: "string", default: "25" },
    ponto: { type: "string", default: String(BRASILEIRAO_A.perPoint) },
    out: { type: "string", default: "sim-output" },
    ancora: { type: "string", default: DEFAULT_MARKET_MAKER.anchor },
    recompra: { type: "string", default: "0" },
  },
});

const season = loadSeason(values.data!);
const perBot = Number(values.bots);
const perPoint = Number(values.ponto);
const scale = perPoint / BRASILEIRAO_A.perPoint;
const anchor = values.ancora === "peer" ? "peer" : "lastTrade";
const buyback = Number(values.recompra);

export interface LoteLinha {
  semente: number;
  /** Soma dos preços finais ÷ soma dos preços do IPO. */
  finalSobreIpo: number;
  /** Soma dos preços ÷ dividendos que ainda faltam, no IPO e na rodada 36. */
  precoSobreDivIpo: number;
  precoSobreDivR36: number;
  /** Correlação de Spearman preço × dividendos restantes, média e mínima das rodadas 1 a 37. */
  correlacaoMedia: number;
  correlacaoMinima: number;
  /** Clubes cujo IPO saiu no piso da faixa. */
  ipoNoPiso: number;
  negocios: number;
  retorno: Record<BotProfile, number>;
}

function resumir(r: SimResult): LoteLinha {
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const stats = r.checkpoints.map(checkpointStats);
  const at = (label: string) => stats.find((s) => s.label === label)!;
  const rounds = stats.filter((s) => {
    const n = /^Rodada (\d+)$/.exec(s.label)?.[1];
    return n !== undefined && Number(n) <= 37;
  });
  const corr = rounds.map((s) => s.correlation);
  const retorno = {} as Record<BotProfile, number>;
  for (const p of PROFILES) {
    const group = r.bots.filter((b) => b.profile === p);
    retorno[p] = group.length ? sum(group.map((b) => b.finalWorth)) / group.length / r.config.initialCash - 1 : Number.NaN;
  }
  return {
    semente: r.config.seed,
    finalSobreIpo: sum(r.clubs.map((c) => c.finalPrice)) / sum(r.clubs.map((c) => c.ipoPrice)),
    precoSobreDivIpo: at("IPO").priceToDividends,
    precoSobreDivR36: at("Rodada 36").priceToDividends,
    correlacaoMedia: sum(corr) / corr.length,
    correlacaoMinima: Math.min(...corr),
    ipoNoPiso: r.clubs.filter((c) => c.ipoPrice === c.band.min).length,
    negocios: r.trades.total,
    retorno,
  };
}

const n = Number(values.sementes);
const started = Date.now();
const linhas: LoteLinha[] = [];
for (let seed = 1; seed <= n; seed++) {
  const result = simulate(season, {
    seed,
    bots: { dividendos: perBot, momentum: perBot, torcedor: perBot, aleatorio: perBot },
    // O dividendo da colocação final acompanha a mesma escala do dividendo por ponto.
    rules: { perPoint, placement: BRASILEIRAO_A.placement.map((v) => Math.round(v * scale)) },
    marketMaker: { ...DEFAULT_MARKET_MAKER, anchor },
    buyback,
  });
  linhas.push(resumir(result));
}

const media = (f: (l: LoteLinha) => number) => linhas.reduce((s, l) => s + f(l), 0) / linhas.length;
const faixa = (f: (l: LoteLinha) => number) => {
  const v = linhas.map(f);
  return `${Math.min(...v).toFixed(2)}–${Math.max(...v).toFixed(2)}`;
};
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

const out: string[] = [];
out.push(`# Lote: ${n} sementes, R$ ${(perPoint / 100).toFixed(2).replace(".", ",")} por ponto, âncora ${anchor}, recompra ${buyback}×, ${perBot * 4} bots`);
out.push("");
out.push("| Medida | Média | Menor–maior |");
out.push("|---|---|---|");
out.push(`| Preço final ÷ IPO | ${media((l) => l.finalSobreIpo).toFixed(2)} | ${faixa((l) => l.finalSobreIpo)} |`);
out.push(`| Preço ÷ dividendos restantes no IPO | ${media((l) => l.precoSobreDivIpo).toFixed(2)} | ${faixa((l) => l.precoSobreDivIpo)} |`);
out.push(`| Preço ÷ dividendos restantes na rodada 36 | ${media((l) => l.precoSobreDivR36).toFixed(1)} | ${faixa((l) => l.precoSobreDivR36)} |`);
out.push(`| Correlação média (Spearman, rodadas 1–37) | ${media((l) => l.correlacaoMedia).toFixed(2)} | ${faixa((l) => l.correlacaoMedia)} |`);
out.push(`| Correlação mínima | ${media((l) => l.correlacaoMinima).toFixed(2)} | ${faixa((l) => l.correlacaoMinima)} |`);
out.push(`| IPOs no piso da faixa (de 20) | ${media((l) => l.ipoNoPiso).toFixed(1)} | ${faixa((l) => l.ipoNoPiso)} |`);
out.push(`| Negócios | ${Math.round(media((l) => l.negocios)).toLocaleString("pt-BR")} | |`);
out.push("");
out.push(`Retorno médio por perfil: ${PROFILES.map((p) => `${p} ${pct(media((l) => l.retorno[p]))}`).join(", ")}.`);
const report = out.join("\n");

mkdirSync(values.out!, { recursive: true });
const tag = `${season.season}-sementes1a${n}-ponto${perPoint}-${anchor}-recompra${buyback}`;
writeFileSync(join(values.out!, `lote-${tag}.json`), JSON.stringify(linhas, null, 2));
console.log(report);
console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)} s; linhas por semente em ${values.out}/lote-${tag}.json)`);
