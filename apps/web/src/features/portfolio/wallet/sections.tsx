import type { AuctionState, EntryItem, WalletView } from "@futbolsa/contracts";
import { auctionNotice } from "../../market/format";
import { ClubBadge } from "../club-badge";
import { formatBp, formatMoney, formatPermille, formatShares, formatSignedMoney, toneClass } from "../format";
import { ENTRY_GROUP_LABELS, ENTRY_KIND_LABELS } from "./wallet-state";

/** O aviso "em leilão até 15h40" (ou o do leilão parado), no mesmo desenho do "em jogo agora" (sem prancha nova). */
export function AuctionChip({ auction }: { auction: AuctionState | null | undefined }) {
  const text = auctionNotice(auction ?? null);
  if (!text) return null;
  return (
    <span className="chip chip-live" data-testid="aviso-leilao">
      <span className="dot-live" />
      {text}
    </span>
  );
}

/** Patrimônio, rentabilidade e o caixa em três pedaços: total, reservado e livre; o caixa negativo fica em destaque. */
export function SummaryCards({ view }: { view: WalletView }) {
  return (
    <section className="stack" aria-label="Resumo da carteira" data-testid="resumo">
      <div className="g-kpi">
        <div className="card card-b">
          <div className="xs muted">Patrimônio</div>
          <div className="disp num" style={{ fontSize: 30 }} data-testid="patrimonio">{formatMoney(view.equity)}</div>
          <div className={`small ${toneClass(view.returnBp)}`} data-testid="rentabilidade">{formatBp(view.returnBp)} na temporada</div>
        </div>
        <div className="card card-b">
          <div className="xs muted">Caixa total</div>
          <div className={`bb num${view.negativeCash ? " neg-cash" : ""}`} style={{ fontSize: 20 }} data-testid="caixa-total">{formatMoney(view.cash.total)}</div>
          <div className="xs muted">já inclui o reservado</div>
        </div>
        <div className="card card-b">
          <div className="xs muted">Reservado em ordens</div>
          <div className="bb num" style={{ fontSize: 20 }} data-testid="caixa-reservado">{formatMoney(view.cash.reserved)}</div>
          <div className="xs muted">livre: <b className={`num${view.negativeCash ? " neg-cash" : ""}`} data-testid="caixa-livre">{formatMoney(view.cash.free)}</b></div>
        </div>
        <div className="card card-b">
          <div className="xs muted">A receber</div>
          <div className="bb num" style={{ fontSize: 20 }} data-testid="a-receber">{formatMoney(view.receivable)}</div>
          <div className="xs muted">dividendos e recompra já fechados</div>
        </div>
      </div>
      {view.negativeCash && (
        <div className="note note-err" role="alert" data-testid="aviso-caixa-negativo">
          <div>Seu caixa está negativo por um estorno de pagamento. Compras ficam bloqueadas até o caixa voltar ao positivo; o patrimônio já soma o valor negativo.</div>
        </div>
      )}
      {view.buybackClosed && (
        <div className="note" role="status" data-testid="aviso-recompra">
          <div>A negociação terminou: as ações valem R$ 0,00 e conta só a recompra a receber.</div>
        </div>
      )}
    </section>
  );
}

/** A barra de composição: a fatia de cada clube e o resto (caixa e a receber). Só porcentagens que o servidor mandou. */
export function CompositionBar({ view }: { view: WalletView }) {
  const slices = view.positions.filter((p) => p.shareOfEquityPermille !== null && p.shareOfEquityPermille > 0);
  if (slices.length === 0) return null;
  const used = slices.reduce((sum, p) => sum + (p.shareOfEquityPermille ?? 0), 0);
  const rest = Math.max(0, 1000 - used);
  const palette = ["#FFB020", "#4FB3FF", "#2BD46F", "#FF8A5C", "#B78CFF", "#6FE0D2"];
  return (
    <section className="card" aria-labelledby="t-comp" data-testid="composicao">
      <div className="card-h"><h2 className="card-t" id="t-comp">Composição</h2></div>
      <div className="card-b stack-s">
        <div className="comp-bar" role="img" aria-label={`Composição: ${slices.map((p) => `${p.club.ticker} ${formatPermille(p.shareOfEquityPermille!)}`).join(", ")}, caixa e a receber ${formatPermille(rest)}`}>
          {slices.map((p, i) => (
            <span key={p.club.ticker} style={{ width: `${(p.shareOfEquityPermille ?? 0) / 10}%`, background: palette[i % palette.length] }} />
          ))}
          <span style={{ width: `${rest / 10}%`, background: "var(--line2)" }} />
        </div>
        <div className="comp-legend">
          {slices.map((p, i) => (
            <span key={p.club.ticker}><i style={{ background: palette[i % palette.length] }} />{p.club.ticker} {formatPermille(p.shareOfEquityPermille!)}</span>
          ))}
          <span><i style={{ background: "var(--line2)" }} />Caixa e a receber {formatPermille(rest)}</span>
        </div>
      </div>
    </section>
  );
}

/** As posições abertas: preço médio, valor a mercado, resultado não realizado, dividendos, a receber e fatia. */
export function PositionsTable({ view }: { view: WalletView }) {
  return (
    <section className="card" aria-labelledby="t-pos" data-testid="posicoes">
      <div className="card-h"><h2 className="card-t" id="t-pos">Posições</h2></div>
      {view.positions.length === 0 ? (
        <div className="card-b small muted" data-testid="sem-posicoes">Você ainda não tem ações. O caixa continua rendendo nada: veja os clubes no mercado.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Clube</th><th className="r">Ações</th><th className="r">Preço médio</th><th className="r">Preço</th>
                <th className="r">Valor</th><th className="r">Resultado</th><th className="r">Dividendos</th><th className="r">A receber</th><th className="r">Fatia</th><th><span className="sr-only">Negociar</span></th>
              </tr>
            </thead>
            <tbody>
              {view.positions.map((p) => (
                <tr key={p.club.ticker} data-testid="posicao" data-ticker={p.club.ticker}>
                  <td>
                    <ClubBadge club={p.club} />
                    {p.auction && <div><AuctionChip auction={p.auction} /></div>}
                  </td>
                  <td className="r num">
                    {formatShares(p.shares)}
                    {p.inOrders > 0 && <div className="xs muted">{formatShares(p.inOrders)} em ordens</div>}
                  </td>
                  <td className="r num">{formatMoney(p.averagePrice)}</td>
                  <td className="r num">{formatMoney(p.price)}</td>
                  <td className="r num">{formatMoney(p.marketValue)}</td>
                  <td className={`r num ${toneClass(p.unrealized)}`}>
                    {formatSignedMoney(p.unrealized)}
                    <div className="xs">{formatPermille(p.unrealizedPermille, true)}</div>
                  </td>
                  <td className="r num">{formatMoney(p.dividends)}</td>
                  <td className="r num">{formatMoney(p.receivable)}</td>
                  <td className="r num">{p.shareOfEquityPermille === null ? "—" : formatPermille(p.shareOfEquityPermille)}</td>
                  <td className="r">
                    <a href={`/clube?t=${p.club.ticker}`} className="btn btn-sm" data-testid="negociar" aria-label={`Negociar ${p.club.ticker}`}>Negociar</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** O resultado total de cada clube, inclusive os que já zeraram: realizado, não realizado, dividendos e a receber. */
export function ResultsTable({ view }: { view: WalletView }) {
  if (view.results.length === 0) return null;
  return (
    <section className="card" aria-labelledby="t-res" data-testid="resultados">
      <div className="card-h"><h2 className="card-t" id="t-res">Resultado por clube</h2></div>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr><th>Clube</th><th className="r">Realizado</th><th className="r">Não realizado</th><th className="r">Dividendos</th><th className="r">A receber</th><th className="r">Total</th></tr>
          </thead>
          <tbody>
            {view.results.map((r) => (
              <tr key={r.club.ticker} data-testid="resultado" data-ticker={r.club.ticker}>
                <td><ClubBadge club={r.club} showName={false} /></td>
                <td className={`r num ${toneClass(r.realized)}`}>{formatSignedMoney(r.realized)}</td>
                <td className={`r num ${toneClass(r.unrealized)}`}>{formatSignedMoney(r.unrealized)}</td>
                <td className="r num">{formatMoney(r.dividends)}</td>
                <td className="r num">{formatMoney(r.receivable)}</td>
                <td className={`r num b ${toneClass(r.total)}`}>{formatSignedMoney(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** O que a linha do extrato diz além do tipo: o evento do dividendo, o motivo do estorno ou do ajuste, o leilão. */
export function entryDetail(e: EntryItem): string {
  if (e.payout) return `${e.payout.reason} · ${formatMoney(e.payout.perShare)} × ${formatShares(e.payout.shares)} ações`;
  if (e.reason) return e.reason;
  return "";
}

/** Uma linha do extrato: nunca mostra a outra ponta do negócio. */
export function EntryRow({ entry }: { entry: EntryItem }) {
  return (
    <tr data-testid="linha-extrato" data-entry-id={entry.id}>
      <td className="num">{shortDate(entry.at)}</td>
      <td>
        <span className="b">{ENTRY_KIND_LABELS[entry.kind] ?? entry.kind}</span>
        {entry.annulled && <span className="chip chip-down" data-testid="marca-anulado" style={{ marginLeft: 6 }}>anulado</span>}
        {entry.inAuction && <span className="chip chip-live" data-testid="marca-leilao" style={{ marginLeft: 6 }}>no leilão</span>}
        {entryDetail(entry) && <div className="xs muted">{entryDetail(entry)}</div>}
      </td>
      <td>{entry.club ? <ClubBadge club={entry.club} showName={false} /> : "—"}</td>
      <td className={`r num ${toneClass(entry.quantity)}`}>{entry.quantity === 0 ? "—" : `${entry.quantity > 0 ? "+" : "−"}${formatShares(Math.abs(entry.quantity))}`}</td>
      <td className="r num">{entry.price === null ? "—" : formatMoney(entry.price)}</td>
      <td className={`r num ${toneClass(entry.amount)}`}>{formatSignedMoney(entry.amount)}</td>
      <td className={`r num ${entry.realized === null ? "muted" : toneClass(entry.realized)}`}>{entry.realized === null ? "—" : formatSignedMoney(entry.realized)}</td>
      <td className="r num">{formatMoney(entry.cashAfter)}</td>
    </tr>
  );
}

export { ENTRY_GROUP_LABELS };
