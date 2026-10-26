import { formatBRL } from "../engine/money.js";
import { PROFILES } from "./bots.js";
import type { Checkpoint, SimResult } from "./simulate.js";

/** Correlação de Spearman (por postos) entre duas séries do mesmo tamanho. */
export function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i]! - mx) * (ry[i]! - my);
    dx += (rx[i]! - mx) ** 2;
    dy += (ry[i]! - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

export interface CheckpointStats {
  label: string;
  /** Correlação entre preço e dividendos que ainda viriam (1 = ordem perfeita). */
  correlation: number;
  /** Soma dos preços ÷ soma dos dividendos restantes (1 = preço justo). */
  priceToDividends: number;
}

export function checkpointStats(c: Checkpoint): CheckpointStats {
  const ids = Object.keys(c.prices);
  const prices = ids.map((id) => c.prices[id]!);
  const remaining = ids.map((id) => c.remainingDividends[id]!);
  const totalRemaining = remaining.reduce((s, x) => s + x, 0);
  return {
    label: c.label,
    correlation: spearman(prices, remaining),
    priceToDividends: totalRemaining ? prices.reduce((s, x) => s + x, 0) / totalRemaining : Number.NaN,
  };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

export function renderReport(r: SimResult): string {
  const lines: string[] = [];
  const nBots = r.bots.length;
  lines.push(`# Simulação FutBolsa: temporada ${r.season}`);
  lines.push("");
  lines.push(
    `Semente ${r.config.seed}, ${nBots} bots, R$ 0,${String(r.config.rules.perPoint).padStart(2, "0")} por ponto, ` +
      `${r.config.sharesPerPlayer} ações por clube por jogador, faixa do IPO ±${r.config.bandWidth * 100}%.`,
  );
  lines.push("");

  lines.push("## Preços por clube");
  lines.push("");
  lines.push("| Clube | Col. anterior | Faixa IPO | IPO | Mín | Máx | Antes do pagamento final | Final | Dividendos/ação | Col. final |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const c of [...r.clubs].sort((a, b) => a.finalPosition - b.finalPosition)) {
    const ipoNote = c.ipoTreasuryShares > 0 ? ` (sobra ${c.ipoTreasuryShares})` : c.ipoFillRatio < 1 ? " (rateio)" : "";
    lines.push(
      `| ${c.clubId} ${c.name} | ${c.ipoPosition}º | ${formatBRL(c.band.min)}–${formatBRL(c.band.max)} | ` +
        `${formatBRL(c.ipoPrice)}${ipoNote} | ${formatBRL(c.minPrice)} | ${formatBRL(c.maxPrice)} | ` +
        `${formatBRL(c.priceBeforeFinalPayout)} | ${formatBRL(c.finalPrice)} | ${formatBRL(c.dividendsPerShare)} | ${c.finalPosition}º |`,
    );
  }
  lines.push("");

  lines.push("## Autocorreção pelos dividendos");
  lines.push("");
  lines.push(
    "Compara, em cada momento, o preço de cada ação com os dividendos que ela ainda pagaria até o fim da temporada " +
      "(usando o resultado real). Correlação perto de 1 = o mercado ordena os clubes como os dividendos; " +
      "preço ÷ dividendos perto de 1 = preço no valor justo.",
  );
  lines.push("");
  lines.push("| Momento | Correlação preço × dividendos restantes | Preço ÷ dividendos restantes |");
  lines.push("|---|---|---|");
  const stats = r.checkpoints.map(checkpointStats);
  const wanted = new Set(["IPO", "Rodada 5", "Rodada 10", "Rodada 19", "Rodada 28", "Rodada 33", "Rodada 36"]);
  for (const s of stats.filter((s) => wanted.has(s.label))) {
    lines.push(`| ${s.label} | ${s.correlation.toFixed(2)} | ${Number.isFinite(s.priceToDividends) ? s.priceToDividends.toFixed(2) : "—"} |`);
  }
  lines.push("");

  lines.push("## Bots por perfil");
  lines.push("");
  lines.push("| Perfil | Bots | Patrimônio médio final | Retorno médio | Melhor | Pior | Dividendos médios |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const profile of PROFILES) {
    const group = r.bots.filter((b) => b.profile === profile);
    if (!group.length) continue;
    const worth = group.map((b) => b.finalWorth);
    const avg = worth.reduce((s, x) => s + x, 0) / group.length;
    const div = group.reduce((s, b) => s + b.dividendsReceived, 0) / group.length;
    lines.push(
      `| ${profile} | ${group.length} | ${formatBRL(avg)} | ${pct(avg / r.config.initialCash - 1)} | ` +
        `${formatBRL(Math.max(...worth))} | ${formatBRL(Math.min(...worth))} | ${formatBRL(div)} |`,
    );
  }
  lines.push("");

  lines.push("## Mercado");
  lines.push("");
  lines.push(
    `- Negócios: ${r.trades.total.toLocaleString("pt-BR")} (${r.trades.peer.toLocaleString("pt-BR")} entre bots, ` +
      `${r.trades.withHouse.toLocaleString("pt-BR")} com o formador de mercado), volume ${formatBRL(r.trades.volume)}.`,
  );
  lines.push(`- Dividendos pagos aos bots: ${formatBRL(r.totalDividends)}.`);
  lines.push(
    `- Tesouraria: ${formatBRL(r.treasury.startCash)} em caixa após o IPO; no fim ${formatBRL(r.treasury.finalCash)} em caixa ` +
      `+ ${formatBRL(r.treasury.finalSharesValue)} em ações.`,
  );
  lines.push("");
  return lines.join("\n");
}
