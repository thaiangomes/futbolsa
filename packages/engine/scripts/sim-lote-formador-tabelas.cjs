// Junta os JSON da sim-lote-formador.mts em tabelas por configuração (lote, mínimo).
// Uso: node scripts/sim-lote-formador-tabelas.cjs resultados.json [outros.json ...]
const runs = process.argv.slice(2).flatMap((f) => require(require("node:path").resolve(f)));
const key = (r) => `${r.cfg.lot}|${r.cfg.minSide}`;
const groups = new Map();
for (const r of runs) {
  const k = key(r);
  if (!groups.has(k)) groups.set(k, { base: [], pump: [], fan: [] });
  groups.get(k)[r.cfg.pump ? "pump" : r.cfg.fan ? "fan" : "base"].push(r);
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f2 = (x) => x.toFixed(2).replace(".", ",");
const f1 = (x) => x.toFixed(1).replace(".", ",");
const pct = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(0)}%`;
const brl = (c) => `R$ ${Math.round(c / 100).toLocaleString("pt-BR")}`;
const PROFILES = ["dividendos", "momentum", "torcedor", "aleatorio", "trader", "captura", "analista", "concentrador", "antecipador"];

const rows = [];
for (const [k, g] of groups) {
  const [lot, min] = k.split("|").map(Number);
  const b = g.base;
  const disp = b.flatMap((r) => r.clubs.filter((c) => r.disputed.includes(c.id)));
  const all = b.flatMap((r) => r.clubs);
  const outDays = disp.filter((c) => c.outDay !== null).map((c) => c.outDay);
  const p = g.pump.flatMap((r) => r.pumps);
  const first = g.pump.map((r) => r.pumps[0]).filter(Boolean);
  rows.push({
    lot, min,
    n: b.length,
    disputados: mean(b.map((r) => r.disputed.length)),
    vaziosNoInicio: mean(b.map((r) => r.clubs.filter((c) => r.disputed.includes(c.id) && c.startShares === 0).length)),
    zeramPct: outDays.length / disp.length,
    diaZera: median(outDays),
    tempoVazio: mean(disp.map((c) => c.emptyShare)),
    tempoVazioTodos: mean(all.map((c) => c.emptyShare)),
    dia7: mean(disp.map((c) => c.ratioAt7)),
    max30: mean(disp.map((c) => c.ratioMax30)),
    max30Pior: mean(b.map((r) => Math.max(...r.clubs.filter((c) => r.disputed.includes(c.id)).map((c) => c.ratioMax30)))),
    mediaTemp: mean(disp.map((c) => c.ratioMean)),
    corr: mean(b.map((r) => r.corrMean)),
    casa: mean(b.map((r) => r.houseResult)),
    negocios: mean(b.map((r) => r.trades)),
    comCasa: mean(b.map((r) => r.houseTrades)),
    retorno: Object.fromEntries(PROFILES.map((pr) => [pr, mean(b.map((r) => r.retorno[pr]))])),
    // Inflação no fim do 1º mês (a primeira tentativa, com o preço ainda normal).
    inflMult: median(first.map((x) => x.after / x.before)),
    inflPassos: median(first.map((x) => x.steps)),
    inflDaCasa: mean(first.map((x) => x.fromHouse)),
    inflGanho: median(first.map((x) => x.paperGain / x.worthBefore)),
    inflPremio: mean(first.map((x) => x.premium)),
    inflDiaSeguinte: median(first.filter((x) => x.priceAfterDay).map((x) => x.priceAfterDay / x.after)),
    congelou: first.filter((x) => x.priceAfterDay && x.priceAfterDay / x.after >= 0.9).length / first.length,
    infladoresFinal: mean(g.pump.map((r) => r.colluders)),
    corrComInfla: mean(g.pump.map((r) => r.corrMean)),
    fanMean: mean(g.fan.map((r) => r.fan.mean)),
    fanMax: mean(g.fan.map((r) => r.fan.max)),
    fanDaCasa: mean(g.fan.map((r) => r.fan.fromHouse)),
    fanFinal: mean(g.fan.map((r) => r.fan.final)),
    fanCasa: mean(g.fan.map((r) => r.houseResult)),
    fanAlvoInicio: mean(g.fan.map((r) => r.clubs.find((c) => c.id === r.target).startShares)),
    fanAlvoVazio: mean(g.fan.map((r) => r.clubs.find((c) => c.id === r.target).emptyShare)),
  });
}
rows.sort((a, b) => a.lot - b.lot || a.min - b.min);
const L = (r) => `${(r.lot * 100).toFixed(0)}% / ${r.min}`;
console.log("| Lote / mínimo | Disputados | Disputados sem ações na estreia | Disputados que zeram | Dia em que zera (mediana) | Tempo zerado (disputados / todos) | Preço ÷ justo no dia 7 | Máximo nos 30 dias (média / pior clube) | Média na temporada | Correlação | Resultado da casa | Negócios (com a casa) |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows)
  console.log(`| ${L(r)} | ${f1(r.disputados)} | ${f1(r.vaziosNoInicio)} | ${(r.zeramPct * 100).toFixed(0)}% | ${isNaN(r.diaZera) ? "–" : f1(r.diaZera)} | ${(r.tempoVazio * 100).toFixed(0)}% / ${(r.tempoVazioTodos * 100).toFixed(0)}% | ${f2(r.dia7)} | ${f2(r.max30)} / ${f2(r.max30Pior)} | ${f2(r.mediaTemp)} | ${f2(r.corr)} | ${brl(r.casa)} | ${Math.round(r.negocios).toLocaleString("pt-BR")} (${Math.round(r.comCasa).toLocaleString("pt-BR")}) |`);
console.log("\n| Lote / mínimo | " + PROFILES.join(" | ") + " |");
console.log("|---|" + PROFILES.map(() => "---").join("|") + "|");
for (const r of rows) console.log(`| ${L(r)} | ${PROFILES.map((p) => pct(r.retorno[p])).join(" | ")} |`);
console.log("\n| Lote / mínimo | Preço depois ÷ antes (mediana) | Negócios de 1 ação (mediana) | Ações compradas da casa | Ganho de papel da dupla | Pago acima do justo | Preço 1 dia depois ÷ inflado | Preço congelado | Dupla no fim | Correlação com a dupla |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows)
  console.log(`| ${L(r)} | ${r.inflMult >= 100 ? Math.round(r.inflMult).toLocaleString("pt-BR") : f1(r.inflMult)}× | ${r.inflPassos} | ${f1(r.inflDaCasa)} | ${pct(r.inflGanho)} | ${brl(r.inflPremio)} | ${f2(r.inflDiaSeguinte)} | ${(r.congelou * 100).toFixed(0)}% | ${pct(r.infladoresFinal)} | ${f2(r.corrComInfla)} |`);
if (rows.some((r) => !isNaN(r.fanMean))) {
  console.log("\n| Lote / mínimo | Ações da casa no alvo na estreia | Tempo do alvo sem ações da casa | Preço ÷ justo do alvo (média / máximo nos 60 dias) | Ações que o fanático comprou da casa | Fanático no fim |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) if (!isNaN(r.fanMean))
    console.log(`| ${L(r)} | ${Math.round(r.fanAlvoInicio)} | ${(r.fanAlvoVazio * 100).toFixed(0)}% | ${f2(r.fanMean)} / ${f2(r.fanMax)} | ${Math.round(r.fanDaCasa)} | ${pct(r.fanFinal)} |`);
}
