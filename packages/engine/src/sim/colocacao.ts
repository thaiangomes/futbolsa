/**
 * Rodada F de calibração (colocação): compara a tabela de dividendos da Série A atual (A) com a proposta de
 * 2026-11-19 (B, com bônus de Libertadores e Sul-Americana) e com B mais penalização de rebaixamento (B1, B2, B3).
 * Só simulação: não muda as regras do jogo (a penalização é um campo opcional de `LeagueRules`, desligado por padrão).
 *
 * Uso:
 *   npm run sim:colocacao -- [--sementes 10] [--cenarios A,B,B1,B2,B3] [--out sim-output]
 *
 * Simplificação: Libertadores do 1º ao 6º e Sul-Americana do 7º ao 12º, o clube nas duas só recebe a Libertadores.
 * No jogo real o admin marca os classificados; os bônus entram na colocação e, portanto, na base da recompra.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadSeason } from "../data/season.js";
import { BRASILEIRAO_A, COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA, type CupRules, type LeagueRules } from "../engine/dividends.js";
import { fairValue, projectLeague, pointsPerGame, type LeagueProjection } from "../engine/fairValue.js";
import { MIN_PRICE } from "../engine/money.js";
import { finishTime, type Match } from "../engine/types.js";
import { roundCloseTimes, computeStandings, type StandingRow } from "../engine/dividends.js";
import { PROFILES, type BotProfile } from "./bots.js";
import { checkpointStats, spearman } from "./report.js";
import { simulate, type SimResult } from "./simulate.js";
import type { MarketView } from "./market.js";

const { values } = parseArgs({
  options: {
    data: { type: "string", default: "data/brasileirao-2025.json" },
    sementes: { type: "string", default: "10" },
    cenarios: { type: "string", default: "A,B,B1,B2,B3,N" },
    out: { type: "string", default: "sim-output" },
  },
});

const BASE_B = [1000, 700, 500, 450, 400, 350, 300, 270, 240, 210, 180, 150, 120, 90, 60, 30];
const withBonus = (base: number[]) => base.map((v, i) => v + (i < 6 ? 300 : i < 12 ? 100 : 0));
const pen = (p: number) => [...Array(16).fill(0), p, p, p, p] as number[];

const SCENARIOS: Record<string, { label: string; rules: LeagueRules }> = {
  A: { label: "A: atual", rules: { perPoint: 10, placement: [...BRASILEIRAO_A.placement] } },
  B: { label: "B: proposta", rules: { perPoint: 10, placement: withBonus(BASE_B) } },
  B1: { label: "B + rebaixados −R$ 1,00", rules: { perPoint: 10, placement: withBonus(BASE_B), penalty: pen(100) } },
  B2: { label: "B + rebaixados −R$ 2,00", rules: { perPoint: 10, placement: withBonus(BASE_B), penalty: pen(200) } },
  B3: { label: "B + rebaixados −R$ 3,00", rules: { perPoint: 10, placement: withBonus(BASE_B), penalty: pen(300) } },
  // A tabela adotada em 2026-11-20 (B1 no jogo): bônus de classificação projetado, penalização de R$ 1,00 e faixa do IPO com o dividendo maior
  N: { label: "N: adotada (B1 no jogo, faixa do IPO acompanha)", rules: BRASILEIRAO_A },
};

const season = loadSeason(values.data!);
const CUP_RULES: Record<string, CupRules> = { libertadores: LIBERTADORES, "copa-do-brasil": COPA_DO_BRASIL, "sul-americana": SULAMERICANA };
const cups = Object.keys(CUP_RULES).map((c) => ({
  matches: (JSON.parse(readFileSync(`data/${c}-${season.season}.json`, "utf8")) as { matches: Match[] }).matches,
  rules: CUP_RULES[c]!,
}));
const clubIds = season.clubs.map((c) => c.id);
const matches = [...season.matches].sort((a, b) => finishTime(a) - finishTime(b));
const finalPos = new Map(computeStandings(matches).map((r, i) => [r.clubId, i + 1]));
const lastRoundTimes = [...roundCloseTimes(matches)].sort((a, b) => a[0] - b[0]);
const t33 = lastRoundTimes.find(([r]) => r === 33)![1];
const BUYBACK = 1.5;

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : Number.NaN);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

interface RunMetrics {
  finalSobreIpo: number;
  precoSobreDivIpo: number;
  corrMedia: number;
  corrMin: number;
  /** Preço ÷ valor justo (média das médias diárias dos 20 clubes) e correlação de Spearman preço × justo. */
  precoSobreJusto: number;
  corrJusto: number;
  retorno: Record<BotProfile, number>;
  /** Retorno de comprar no IPO e segurar (dividendos × (1 + recompra) − penalização) ÷ preço do IPO, por faixa. */
  faixaIpo: number[];
  /** Zona de rebaixamento (17º a 20º real) da rodada 33 ao fim. */
  zona: { precoSobreJusto: number; variacaoR33: number; passosSemComprador: number; passosNoPiso: number };
  justoNegativoPassos: number;
  justoMinimo: number;
  negocios: number;
  penalidade?: { total: number; botsNegativos: number };
  negativosApos: number;
}

function runOne(scn: { rules: LeagueRules }, seed: number): RunMetrics {
  let steps = 0;
  const ratio: number[] = [];
  const corrJ: number[] = [];
  let negSteps = 0;
  let minFair = Infinity;
  const zoneRatio: number[] = [];
  let zoneNoBid = 0;
  let zoneSteps = 0;
  let zoneFloor = 0;
  const zoneIds = clubIds.filter((id) => finalPos.get(id)! >= 17);
  const r = simulate(season, { seed, rules: scn.rules, cups }, {
    onStep: (t, view: MarketView, ids) => {
      const fairs = ids.map((id) => fairValue((view as unknown as { fairValueInput(id: string): never }).fairValueInput(id)));
      steps++;
      fairs.forEach((f) => {
        if (f < 0) negSteps++;
        minFair = Math.min(minFair, f);
      });
      const prices = ids.map((id) => view.price(id));
      if (steps % 8 === 0) {
        const rs = ids.map((_, i) => (fairs[i]! > 0 ? prices[i]! / fairs[i]! : NaN)).filter((x) => !Number.isNaN(x));
        ratio.push(mean(rs));
        corrJ.push(spearman(prices, fairs));
      }
      if (t >= t33) {
        ids.forEach((id, i) => {
          if (!zoneIds.includes(id)) return;
          zoneSteps++;
          if (fairs[i]! > 0) zoneRatio.push(prices[i]! / fairs[i]!);
          if (!view.exchange.bestBid(id)) zoneNoBid++;
          if (prices[i]! <= MIN_PRICE) zoneFloor++;
        });
      }
    },
  });
  const stats = r.checkpoints.map(checkpointStats);
  const rounds = stats.filter((s) => {
    const n = /^Rodada (\d+)$/.exec(s.label)?.[1];
    return n !== undefined && Number(n) <= 37;
  });
  const retorno = {} as Record<BotProfile, number>;
  for (const p of PROFILES) {
    const g = r.bots.filter((b) => b.profile === p);
    retorno[p] = g.length ? sum(g.map((b) => b.finalWorth)) / g.length / r.config.initialCash - 1 : NaN;
  }
  const ck33 = r.checkpoints.find((c) => c.label === "Rodada 33")!;
  const totalRet = (c: SimResult["clubs"][number]) => {
    const p = scn.rules.penalty?.[c.finalPosition - 1] ?? 0;
    return (c.dividendsPerShare * (1 + BUYBACK) - p) / c.ipoPrice - 1;
  };
  const tiers = [
    (p: number) => p <= 5,
    (p: number) => p >= 6 && p <= 10,
    (p: number) => p >= 11 && p <= 15,
    (p: number) => p >= 16,
  ];
  const faixaIpo = tiers.map((f) => mean(r.clubs.filter((c) => f(c.ipoPosition)).map(totalRet)));
  const zoneClubs = r.clubs.filter((c) => c.finalPosition >= 17);
  return {
    finalSobreIpo: sum(r.clubs.map((c) => c.finalPrice)) / sum(r.clubs.map((c) => c.ipoPrice)),
    precoSobreDivIpo: stats.find((s) => s.label === "IPO")!.priceToDividends,
    corrMedia: mean(rounds.map((s) => s.correlation)),
    corrMin: Math.min(...rounds.map((s) => s.correlation)),
    precoSobreJusto: mean(ratio),
    corrJusto: mean(corrJ),
    retorno,
    faixaIpo,
    zona: {
      precoSobreJusto: mean(zoneRatio),
      variacaoR33: mean(zoneClubs.map((c) => c.priceBeforeFinalPayout / ck33.prices[c.clubId]! - 1)),
      passosSemComprador: zoneSteps ? zoneNoBid / zoneSteps : NaN,
      passosNoPiso: zoneSteps ? zoneFloor / zoneSteps : NaN,
    },
    justoNegativoPassos: negSteps,
    justoMinimo: minFair,
    negocios: r.trades.total,
    penalidade: r.penalty ? { total: r.penalty.total, botsNegativos: r.penalty.botsNegative } : undefined,
    negativosApos: r.bots.filter((b) => b.finalWorth < 0).length,
  };
}

// ---- Sensibilidade a gols: valor justo com +1 e +3 pontos, por faixa da tabela --------------------------------------
function withStandings(base: LeagueProjection, standings: Map<string, StandingRow>): LeagueProjection {
  const proj: LeagueProjection = { ...base, standings, projectedRank: new Map() };
  const projected = base.clubIds.map((id) => {
    const row = standings.get(id);
    return { id, final: (row?.points ?? 0) + pointsPerGame(proj, id) * Math.max(0, base.gamesPerClub - (row?.played ?? 0)) };
  });
  projected.sort((a, b) => b.final - a.final);
  proj.projectedRank = new Map(projected.map((p, i) => [p.id, i + 1]));
  return proj;
}

interface Sens {
  tier: string;
  fv: number;
  d1: number;
  d3: number;
}
function sensitivity(rules: LeagueRules): Sens[] {
  const tiers: Array<[string, (rank: number) => boolean]> = [
    ["título (1º–2º)", (r) => r <= 2],
    ["vaga Libertadores (3º–6º)", (r) => r >= 3 && r <= 6],
    ["meio (7º–16º)", (r) => r >= 7 && r <= 16],
    ["rebaixamento (17º–20º)", (r) => r >= 17],
  ];
  const acc = new Map(tiers.map(([n]) => [n, { fv: [] as number[], d1: [] as number[], d3: [] as number[] }]));
  const gpc = (2 * matches.length) / clubIds.length;
  for (const round of [10, 20, 30, 36]) {
    const known = matches.filter((m) => m.status === "finished" && m.round! <= round);
    const base = projectLeague(known, clubIds, gpc);
    const input = (proj: LeagueProjection, id: string) => ({
      projection: proj,
      clubId: id,
      rules,
      buybackMultiple: BUYBACK,
      closedPoints: proj.standings.get(id)?.points ?? 0,
      placementClosed: false,
      cupClosed: 0,
      cupExpected: 0,
    });
    for (const id of clubIds) {
      const rank = base.projectedRank.get(id)!;
      const fv0 = fairValue(input(base, id));
      const bump = (pts: number) => {
        const st = new Map(base.standings);
        const row = st.get(id)!;
        st.set(id, { ...row, points: row.points + pts });
        const proj = withStandings(base, st);
        // pontos "novos" ainda não fechados: closedPoints continua o da tabela de antes
        return fairValue({ ...input(proj, id), closedPoints: row.points }) - fv0;
      };
      const [name] = tiers.find(([, f]) => f(rank))!;
      const a = acc.get(name)!;
      a.fv.push(fv0);
      a.d1.push(bump(1));
      a.d3.push(bump(3));
    }
  }
  return tiers.map(([n]) => ({ tier: n, fv: mean(acc.get(n)!.fv), d1: mean(acc.get(n)!.d1), d3: mean(acc.get(n)!.d3) }));
}

// ---- Execução ------------------------------------------------------------------------------------------------------
const n = Number(values.sementes);
const names = values.cenarios!.split(",");
const started = Date.now();
const all: Record<string, { runs: RunMetrics[]; sens: Sens[] }> = {};
for (const name of names) {
  const scn = SCENARIOS[name];
  if (!scn) throw new Error(`Cenário desconhecido: ${name}`);
  const runs: RunMetrics[] = [];
  for (let seed = 1; seed <= n; seed++) runs.push(runOne(scn, seed));
  all[name] = { runs, sens: sensitivity(scn.rules) };
  console.error(`${name}: ${n} sementes em ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");
const pct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%` : "—");
const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;
const col = (f: (m: RunMetrics) => number) => (name: string) => mean(all[name]!.runs.map(f));
const out: string[] = [];
const row = (title: string, f: (name: string) => string) => out.push(`| ${title} | ${names.map(f).join(" | ")} |`);
out.push(`| Medida | ${names.map((x) => SCENARIOS[x]!.label).join(" | ")} |`);
out.push(`|---|${names.map(() => "---").join("|")}|`);
row("Preço final ÷ IPO", (x) => fmt(col((m) => m.finalSobreIpo)(x)));
row("Preço ÷ dividendos restantes no IPO", (x) => fmt(col((m) => m.precoSobreDivIpo)(x)));
row("Preço ÷ valor justo (média do ano)", (x) => fmt(col((m) => m.precoSobreJusto)(x)));
row("Correlação preço × justo (Spearman)", (x) => fmt(col((m) => m.corrJusto)(x)));
row("Correlação preço × dividendos restantes, média", (x) => fmt(col((m) => m.corrMedia)(x)));
row("Correlação preço × dividendos restantes, mínima", (x) => fmt(col((m) => m.corrMin)(x)));
for (const p of PROFILES) row(`Retorno do bot ${p}`, (x) => pct(col((m) => m.retorno[p])(x)));
for (const [i, t] of ["IPO 1º–5º", "IPO 6º–10º", "IPO 11º–15º", "IPO 16º–20º"].entries())
  row(`Comprar no IPO e segurar, ${t}`, (x) => pct(col((m) => m.faixaIpo[i]!)(x)));
row("Rebaixados: preço ÷ justo, rodada 33 em diante", (x) => fmt(col((m) => m.zona.precoSobreJusto)(x)));
row("Rebaixados: variação do preço, rodada 33 até antes da colocação", (x) => pct(col((m) => m.zona.variacaoR33)(x)));
row("Rebaixados: passos sem comprador (%)", (x) => pct(col((m) => m.zona.passosSemComprador)(x)));
row("Rebaixados: passos com preço no piso (%)", (x) => pct(col((m) => m.zona.passosNoPiso)(x)));
row("Valor justo negativo (passos × clubes, média)", (x) => fmt(col((m) => m.justoNegativoPassos)(x), 0));
row("Menor valor justo visto", (x) => brl(Math.min(...all[x]!.runs.map((m) => m.justoMinimo))));
row("Bots com caixa negativo após a penalização (média)", (x) => fmt(col((m) => m.penalidade?.botsNegativos ?? 0)(x), 1));
row("Total debitado dos bots (média)", (x) => brl(col((m) => m.penalidade?.total ?? 0)(x)));
row("Negócios", (x) => Math.round(col((m) => m.negocios)(x)).toLocaleString("pt-BR"));
out.push("");
out.push("Quanto muda o valor justo (com a recompra de 1,5×) se o clube ganha pontos, média das rodadas 10, 20, 30 e 36:");
out.push("");
out.push(`| Faixa | ${names.map((x) => `${x}: valor justo / +1 ponto / +3 pontos`).join(" | ")} |`);
out.push(`|---|${names.map(() => "---").join("|")}|`);
for (let i = 0; i < 4; i++) {
  out.push(`| ${all[names[0]!]!.sens[i]!.tier} | ${names.map((x) => { const s = all[x]!.sens[i]!; return `${brl(s.fv)} / ${brl(s.d1)} / ${brl(s.d3)}`; }).join(" | ")} |`);
}
const report = `# Rodada F (colocação): ${n} sementes, R$ 0,10 por ponto, 9 perfis de bot, copas, recompra 1,5×\n\n${out.join("\n")}`;
mkdirSync(values.out!, { recursive: true });
writeFileSync(join(values.out!, `colocacao-${season.season}-sementes${n}.json`), JSON.stringify(all, null, 2));
console.log(report);
console.log(`\n(${((Date.now() - started) / 1000).toFixed(0)} s)`);
