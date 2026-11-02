// Tabelas da rodada do túnel de preço (opção --tuneis da sim-lote-formador.mts).
// Uso: node scripts/sim-lote-formador-tunel.cjs resultados.json
const runs = process.argv.slice(2).flatMap((f) => require(require("node:path").resolve(f)));
const mode = (r) => (r.cfg.slow ? "slow" : r.cfg.pump ? "pump" : r.cfg.fan ? "fan" : "base");
const tunnels = [...new Set(runs.map((r) => r.cfg.tunnel))].sort((a, b) => a - b);
const of = (t, m) => runs.filter((r) => r.cfg.tunnel === t && mode(r) === m);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const f2 = (x) => x.toFixed(2).replace(".", ",");
const pct = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`;
const mult = (x) => `${x >= 100 ? Math.round(x).toLocaleString("pt-BR") : f2(x)}×`;
const mil = (c) => `R$ ${Math.round(c / 100_000).toLocaleString("pt-BR")} mil`;
const T = (t) => (t ? `${t * 100}%` : "sem túnel");
const PROFILES = ["dividendos", "momentum", "torcedor", "aleatorio", "trader", "captura", "analista", "concentrador", "antecipador"];

console.log("| Túnel | Leilões por temporada | Tempo de um clube em leilão | Correlação | Resultado da casa | Negócios (em leilão) |");
console.log("|---|---|---|---|---|---|");
for (const t of tunnels) {
  const b = of(t, "base");
  const steps = mean(b.map((r) => r.auctionSteps));
  console.log(`| ${T(t)} | ${f2(mean(b.map((r) => r.auctions)))} | ${steps.toFixed(1).replace(".", ",")} passos de 3 h | ${f2(mean(b.map((r) => r.corrMean)))} | ${mil(mean(b.map((r) => r.houseResult)))} | ${Math.round(mean(b.map((r) => r.trades))).toLocaleString("pt-BR")} (${Math.round(mean(b.map((r) => r.auctionTrades)))}) |`);
}
console.log("\n| Túnel | " + PROFILES.join(" | ") + " |");
console.log("|---|" + PROFILES.map(() => "---").join("|") + "|");
for (const t of tunnels) {
  const b = of(t, "base");
  console.log(`| ${T(t)} | ${PROFILES.map((p) => pct(mean(b.map((r) => r.retorno[p])))).join(" | ")} |`);
}
for (const [m, nome] of [["pump", "Dupla apressada"], ["slow", "Dupla paciente"]]) {
  console.log(`\n${nome}:\n`);
  console.log("| Túnel | Preço no fechamento do 1º mês ÷ antes (mediana) | Ganho de papel da dupla no 1º mês (mediana) | Abriu leilão | Preço do Sport no último fechamento ÷ antes do 1º (mediana) | Ações compradas da casa por mês | Dupla no fim |");
  console.log("|---|---|---|---|---|---|---|");
  for (const t of tunnels) {
    const g = of(t, m);
    const first = g.map((r) => r.pumps[0]);
    const all = g.flatMap((r) => r.pumps);
    const acc = g.map((r) => r.pumps[r.pumps.length - 1].after / r.pumps[0].before);
    console.log(`| ${T(t)} | ${mult(median(first.map((p) => p.after / p.before)))} | ${pct(median(first.map((p) => p.paperGain / p.worthBefore)))} | ${Math.round((100 * all.filter((p) => p.auctionHit).length) / all.length)}% dos meses | ${mult(median(acc))} | ${Math.round(mean(all.map((p) => p.fromHouse)))} | ${pct(mean(g.map((r) => r.colluders)))} |`);
  }
}
console.log("\nFanático:\n");
console.log("| Túnel | Preço ÷ justo do Sport (média / máximo em 60 dias) | Ações que ele comprou da casa | Fanático no fim |");
console.log("|---|---|---|---|");
for (const t of tunnels) {
  const g = of(t, "fan");
  console.log(`| ${T(t)} | ${f2(mean(g.map((r) => r.fan.mean)))} / ${f2(mean(g.map((r) => r.fan.max)))} | ${Math.round(mean(g.map((r) => r.fan.fromHouse)))} | ${pct(mean(g.map((r) => r.fan.final)))} |`);
}
