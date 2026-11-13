import type { FraudCaseDetail, FraudMonth, FraudSeriesPoint } from "@futbolsa/contracts";
import { formatBRL } from "@futbolsa/engine";

/**
 * O arquivo do relatório de trapaça (T23): um HTML que abre sozinho, com o CSS embutido e os gráficos em SVG, e imprime em
 * PDF pelo navegador (sem biblioteca). É feito **da foto do caso** (`FraudCaseDetail`), então tem os mesmos números da tela;
 * e como a foto não guarda e-mail nem apelido, depois da exclusão de uma conta o arquivo mostra "conta excluída".
 */

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const when = (iso: string): string => new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });

const pct = (bp: number): string => `${bp >= 0 ? "+" : "−"}${(Math.abs(bp) / 100).toFixed(2).replace(".", ",")}%`;

/** Um gráfico de linhas simples: o preço com e sem os negócios (e o valor justo, se houver) de um clube. */
function chart(points: FraudSeriesPoint[]): string {
  if (points.length < 2) return "";
  const W = 640;
  const H = 200;
  const pad = 36;
  const values = points.flatMap((p) => [p.price, p.priceWithout, ...(p.fairValue === null ? [] : [p.fairValue])]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (points.length - 1);
  const y = (v: number) => H - pad - ((v - min) * (H - 2 * pad)) / span;
  const line = (pick: (p: FraudSeriesPoint) => number | null, cls: string) => {
    const pts = points.flatMap((p, i) => {
      const v = pick(p);
      return v === null ? [] : [`${x(i).toFixed(1)},${y(v).toFixed(1)}`];
    });
    return pts.length > 1 ? `<polyline class="${cls}" fill="none" points="${pts.join(" ")}"/>` : "";
  };
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Preço do clube com e sem os negócios" width="100%">
<rect width="${W}" height="${H}" fill="#fff" stroke="#ddd"/>
<text x="${pad}" y="16" font-size="11" fill="#555">máx. ${esc(formatBRL(max))}</text>
<text x="${pad}" y="${H - 8}" font-size="11" fill="#555">mín. ${esc(formatBRL(min))}</text>
${line((p) => p.fairValue, "fair")}${line((p) => p.priceWithout, "without")}${line((p) => p.price, "with")}
</svg>`;
}

function monthRows(months: FraudMonth[], label: (walletId: number) => string): string {
  return months
    .flatMap((m) =>
      m.accounts.map(
        (a) =>
          `<tr><td>${esc(m.month)}${m.open ? " (agora)" : ""}</td><td>${esc(label(a.walletId))}</td><td class="n">${esc(formatBRL(a.equity))}</td><td class="n">${esc(formatBRL(a.equityWithout))}</td><td class="n">${a.rank ?? "—"}</td><td class="n">${a.rankWithout ?? "—"}</td></tr>`,
      ),
    )
    .join("\n");
}

/** O HTML do relatório, pronto para baixar. */
export function fraudReportHtml(c: FraudCaseDetail): string {
  const label = (walletId: number) => c.parties.find((p) => p.walletId === walletId)?.label ?? "conta excluída";
  const r = c.report;
  const tickers = [...new Set(r.series.map((p) => p.ticker))];
  const status = { open: "aberto", confirmed: "confirmado", dismissed: "descartado" }[c.status];
  const tradeRows = r.trades
    .map(
      (t) =>
        `<tr${t.suspicious ? ' class="sus"' : ""}><td>${esc(when(t.at))}</td><td>${esc(t.ticker)}</td><td>${esc(label(t.buyerWalletId))}</td><td>${esc(label(t.sellerWalletId))}</td><td class="n">${t.quantity}</td><td class="n">${esc(formatBRL(t.price))}</td><td class="n">${esc(formatBRL(t.priceBefore))}</td><td class="n">${pct(t.variationBp)}</td><td>${t.inAuction ? "leilão" : ""}${t.suspicious ? " suspeito" : ""}${t.selected ? " anulado" : ""}${t.annulled && !t.selected ? " já anulado" : ""}</td></tr>`,
    )
    .join("\n");
  const clubRows = r.clubs
    .map(
      (k) =>
        `<tr><td>${esc(k.ticker)}</td><td class="n">${k.pairTrades} de ${k.clubTrades}</td><td class="n">${esc(formatBRL(k.priceFrom))}</td><td class="n">${esc(formatBRL(k.priceTo))}</td><td class="n">${esc(formatBRL(k.priceToWithoutPair))}</td></tr>`,
    )
    .join("\n");
  const otherRows = r.others
    .map((o) => `<tr><td>${esc(when(o.at))}</td><td>${esc(o.ticker)}</td><td>${esc(label(o.walletId))}</td><td>${o.side === "buy" ? "compra" : "venda"}</td><td class="n">${o.quantity}</td><td class="n">${esc(formatBRL(o.price))}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório de trapaça — caso ${c.id}</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;color:#111;margin:24px auto;max-width:960px;padding:0 16px}
h1{font-size:22px}h2{font-size:16px;margin-top:28px}
table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}th{background:#f2f2f2}
td.n{text-align:right;font-variant-numeric:tabular-nums}tr.sus td{background:#fff4d6}
.meta{color:#444}.with{stroke:#c0392b;stroke-width:2}.without{stroke:#2a7;stroke-width:2}.fair{stroke:#888;stroke-width:1.5;stroke-dasharray:4 3}
.legend span{margin-right:16px}@media print{body{margin:0}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}
</style></head><body>
<h1>Relatório de trapaça — caso ${c.id}</h1>
<p class="meta">Situação: <strong>${status}</strong> · origem: ${c.origin === "alert" ? "alerta" : "manual"} · período: ${esc(when(c.periodFrom))} a ${esc(when(c.periodTo))}${c.ticker ? ` · clube: ${esc(c.ticker)}` : ""}<br>
Contas: ${c.parties.map((p) => `${esc(p.label)}${p.warnings ? ` (${p.warnings} advertência${p.warnings > 1 ? "s" : ""} antes)` : ""}`).join(" e ")}
${c.decidedAt ? `<br>Decidido em ${esc(when(c.decidedAt))}${c.decisionReason ? `: ${esc(c.decisionReason)}` : ""}` : ""}
${c.reportHash ? `<br>Hash da foto: <code>${esc(c.reportHash)}</code>` : ""}</p>
<h2>Negócios entre as duas contas</h2>
<table><thead><tr><th>Hora</th><th>Clube</th><th>Comprador</th><th>Vendedor</th><th>Qtd.</th><th>Preço</th><th>Preço antes</th><th>Variação</th><th>Marca</th></tr></thead><tbody>
${tradeRows}
</tbody></table>
<h2>Peso no clube</h2>
<table><thead><tr><th>Clube</th><th>Negócios do par</th><th>Preço no início</th><th>Preço no fim</th><th>Preço no fim sem o par</th></tr></thead><tbody>
${clubRows}
</tbody></table>
${tickers.map((t) => `<h2>Preço de ${esc(t)}</h2><p class="legend"><span style="color:#c0392b">— com os negócios</span><span style="color:#2a7">— sem os negócios</span><span style="color:#888">- - valor justo</span></p>\n${chart(r.series.filter((p) => p.ticker === t))}`).join("\n")}
<h2>Patrimônio e posição no ranking, com e sem os negócios</h2>
<table><thead><tr><th>Mês</th><th>Conta</th><th>Patrimônio com</th><th>Patrimônio sem</th><th>Posição com</th><th>Posição sem</th></tr></thead><tbody>
${monthRows(r.months, label)}
</tbody></table>
<h2>Negócios das duas contas com outros jogadores</h2>
${r.others.length === 0 ? "<p>Nenhum no período.</p>" : `<table><thead><tr><th>Hora</th><th>Clube</th><th>Conta</th><th>Lado</th><th>Qtd.</th><th>Preço</th></tr></thead><tbody>\n${otherRows}\n</tbody></table>`}
<p class="meta">Imprima esta página pelo navegador para salvar em PDF. FutBolsa é um jogo com dinheiro fictício.</p>
</body></html>`;
}
