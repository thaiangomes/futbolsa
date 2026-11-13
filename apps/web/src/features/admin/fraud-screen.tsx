"use client";

import { useEffect, useRef, useState } from "react";
import type { ConfirmFraudResponse, FraudCaseDetail, FraudCaseItem, FraudParty, FraudReport, FraudReportTrade, FraudSeriesPoint } from "@futbolsa/contracts";
import { formatCents, formatInstant, formatInt } from "../../lib/format";
import type { AdminApi } from "./api";
import { reasonFeedback } from "./forms";
import { Card, ErrorNote, LoadState, ReasonField, useAction, useLoader } from "./ui";

const STATUS_LABEL = { open: "aberto", confirmed: "confirmado", dismissed: "descartado" } as const;

/** Os negócios marcados de saída: os suspeitos que ainda não foram anulados por outro caso. */
export function defaultSelection(report: FraudReport): number[] {
  return report.trades.filter((t) => t.suspicious && !t.annulled).map((t) => t.id);
}

/** Variação em pontos-base com sinal, como `+10,00%`. */
export function formatBp(bp: number): string {
  return `${bp >= 0 ? "+" : "−"}${(Math.abs(bp) / 100).toFixed(2).replace(".", ",")}%`;
}

function Party({ party }: { party: FraudParty }) {
  if (party.kind === "bot") return <span><span className="chip">bot</span> {party.label}</span>;
  if (party.kind === "deleted") return <span className="muted">conta excluída</span>;
  return (
    <span>
      {party.label}
      {party.email && <span className="muted xs"> · {party.email}</span>}
      {party.warnings > 0 && <span className="chip chip-down" style={{ marginLeft: 6 }}>{party.warnings} advertência{party.warnings > 1 ? "s" : ""}</span>}
    </span>
  );
}

/** A lista de casos da temporada atual, dos alertas e dos relatórios manuais. */
export function FraudCasesScreen({ admin }: { admin: AdminApi }) {
  const [status, setStatus] = useState<"open" | "all">("open");
  const [cases, setCases] = useState<FraudCaseItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = useAction();
  const first = useRef(true);

  const fetchPage = (append: boolean) =>
    load.run(async () => {
      const page = await admin.fraudCases({ ...(status === "open" ? { status: "open" as const } : {}), ...(append && cursor ? { cursor } : {}) });
      setCases((old) => (append ? [...old, ...page.cases] : page.cases));
      setCursor(page.nextCursor);
    });
  useEffect(() => {
    void fetchPage(false);
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div className="stack">
      <div className="seg" role="group" aria-label="Quais casos">
        <button type="button" aria-pressed={status === "open"} onClick={() => setStatus("open")}>Abertos</button>
        <button type="button" aria-pressed={status === "all"} onClick={() => setStatus("all")}>Todos</button>
      </div>
      <ErrorNote message={load.error} />
      <Card title={`Casos (${cases.length}${cursor ? "+" : ""})`}>
        {cases.length === 0 ? (
          <p className="m0 muted">{load.busy ? "Carregando…" : "Nenhum caso."}</p>
        ) : (
          <table className="tbl">
            <thead><tr><th>Caso</th><th>Origem</th><th>Situação</th><th>Clube</th><th>Contas</th><th className="r">Suspeitos</th><th>Aberto em</th></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td><a href={`/admin/trapaca?id=${c.id}`}>#{c.id}</a></td>
                  <td>{c.origin === "alert" ? "alerta" : "manual"}</td>
                  <td><span className={`chip ${c.status === "open" ? "chip-down" : ""}`}>{STATUS_LABEL[c.status]}</span></td>
                  <td>{c.ticker ?? "todos"}</td>
                  <td><Party party={c.parties[0]} /> e <Party party={c.parties[1]} /></td>
                  <td className="r">{c.suspiciousCount} de {c.tradeCount}</td>
                  <td>{formatInstant(c.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor && <button type="button" className="btn btn-sm" disabled={load.busy} onClick={() => void fetchPage(true)}>Mostrar mais</button>}
      </Card>
      <div className="note"><div>O alerta pega o padrão de 3 ou mais negócios suspeitos (até 10 ações, 5% ou mais fora do preço) do mesmo par no mesmo clube em 7 dias. Quem decide é sempre você. Para um caso fora do padrão, abra o relatório pela auditoria de negócios.</div></div>
    </div>
  );
}

/** Um gráfico simples do preço com e sem os negócios e do valor justo (SVG, sem biblioteca). */
export function PriceChart({ points, ticker }: { points: FraudSeriesPoint[]; ticker: string }) {
  const own = points.filter((p) => p.ticker === ticker);
  if (own.length < 2) return null;
  const W = 640;
  const H = 180;
  const pad = 28;
  const values = own.flatMap((p) => [p.price, p.priceWithout, ...(p.fairValue === null ? [] : [p.fairValue])]);
  const min = Math.min(...values);
  const span = Math.max(1, Math.max(...values) - min);
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (own.length - 1);
  const y = (v: number) => H - pad - ((v - min) * (H - 2 * pad)) / span;
  const line = (pick: (p: FraudSeriesPoint) => number | null, color: string, dash?: string) => {
    const pts = own.flatMap((p, i) => (pick(p) === null ? [] : [`${x(i).toFixed(1)},${y(pick(p)!).toFixed(1)}`]));
    return pts.length > 1 ? <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={2} strokeDasharray={dash} /> : null;
  };
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Preço de ${ticker} com e sem os negócios`}>
        {line((p) => p.fairValue, "#888", "4 3")}
        {line((p) => p.priceWithout, "#2bd46f")}
        {line((p) => p.price, "#ff5c5c")}
      </svg>
      <div className="row xs muted" style={{ gap: 14 }}>
        <span style={{ color: "#ff5c5c" }}>— com os negócios</span>
        <span style={{ color: "#2bd46f" }}>— sem os negócios marcados</span>
        <span>- - valor justo da casa</span>
        <span>de {formatCents(Math.min(...values))} a {formatCents(Math.max(...values))}</span>
      </div>
    </div>
  );
}

function TradesTable({ trades, parties, selected, onToggle, editable }: { trades: FraudReportTrade[]; parties: FraudCaseDetail["parties"]; selected: Set<number>; onToggle(id: number): void; editable: boolean }) {
  const name = (walletId: number) => parties.find((p) => p.walletId === walletId)?.label ?? "conta excluída";
  return (
    <table className="tbl">
      <thead><tr>{editable && <th>Anular</th>}<th>Quando</th><th>Clube</th><th>Comprador</th><th>Vendedor</th><th className="r">Ações</th><th className="r">Preço</th><th className="r">Antes</th><th className="r">Variação</th><th>Marca</th></tr></thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.id}>
            {editable && (
              <td>
                <input type="checkbox" aria-label={`Anular o negócio ${t.id}`} checked={selected.has(t.id)} disabled={t.annulled} onChange={() => onToggle(t.id)} />
              </td>
            )}
            <td>{formatInstant(t.at)}</td><td>{t.ticker}</td><td>{name(t.buyerWalletId)}</td><td>{name(t.sellerWalletId)}</td>
            <td className="r">{formatInt(t.quantity)}</td><td className="r">{formatCents(t.price)}</td><td className="r">{formatCents(t.priceBefore)}</td><td className="r">{formatBp(t.variationBp)}</td>
            <td>
              {t.suspicious && <span className="chip chip-down">suspeito</span>} {t.inAuction && <span className="chip">leilão</span>}{" "}
              {t.annulled && <span className="chip">já anulado</span>} {t.selected && <span className="chip chip-down">anulado</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** O relatório de um caso, com os negócios marcáveis, o efeito antes de confirmar e a decisão. */
export function FraudCaseScreen({ admin, id }: { admin: AdminApi; id: number }) {
  const loader = useLoader(() => admin.fraudCase(id));
  const detail = loader.data;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<ConfirmFraudResponse | null>(null);
  const [preview, setPreview] = useState<FraudReport | null>(null);
  const previewAction = useAction();
  const started = useRef(false);

  useEffect(() => {
    if (detail && !started.current) {
      started.current = true;
      setSelected(new Set(detail.status === "open" ? defaultSelection(detail.report) : []));
    }
  }, [detail]);

  // o efeito de anular só os marcados (o "sem" do relatório) refeito a cada mudança da marcação
  useEffect(() => {
    if (!detail || detail.status !== "open" || !started.current) return;
    const ids = [...selected].sort((a, b) => a - b);
    let alive = true;
    void previewAction.run(async () => {
      const next = await admin.fraudCase(id, ids.length > 0 ? ids : [0]);
      if (alive) setPreview(next.report);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, detail?.status]);

  if (!detail) return <LoadState loader={loader} />;
  const report = preview ?? detail.report;
  const open = detail.status === "open" && result === null;
  const toggle = (tradeId: number) =>
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(tradeId)) next.delete(tradeId);
      else next.add(tradeId);
      return next;
    });
  const tickers = [...new Set(report.series.map((p) => p.ticker))];

  return (
    <div className="stack">
      <Card title={`Caso #${detail.id} · ${STATUS_LABEL[detail.status]}`} right={<DownloadButton admin={admin} id={id} />}>
        <div className="stack-s">
          <div className="kv"><span>Origem</span><span>{detail.origin === "alert" ? "alerta" : "relatório manual"}</span></div>
          <div className="kv"><span>Período</span><span>{formatInstant(detail.periodFrom)} a {formatInstant(detail.periodTo)}{detail.ticker ? ` · ${detail.ticker}` : ""}</span></div>
          <div className="kv"><span>Contas</span><span><Party party={detail.parties[0]} /> e <Party party={detail.parties[1]} /></span></div>
          {detail.decidedAt && <div className="kv"><span>Decidido</span><span>{formatInstant(detail.decidedAt)}{detail.decidedBy ? ` por ${detail.decidedBy}` : ""}: {detail.decisionReason}</span></div>}
          {detail.reportHash && <div className="kv"><span>Hash da foto</span><code className="xs">{detail.reportHash}</code></div>}
        </div>
      </Card>

      <Card title="Negócios entre as duas contas">
        <TradesTable trades={detail.report.trades} parties={detail.parties} selected={selected} onToggle={toggle} editable={open} />
      </Card>

      <Card title="Peso no clube">
        <table className="tbl">
          <thead><tr><th>Clube</th><th className="r">Negócios do par</th><th className="r">Preço no início</th><th className="r">Preço no fim</th><th className="r">No fim, sem o par</th></tr></thead>
          <tbody>
            {report.clubs.map((k) => (
              <tr key={k.ticker}><td>{k.ticker}</td><td className="r">{k.pairTrades} de {k.clubTrades}</td><td className="r">{formatCents(k.priceFrom)}</td><td className="r">{formatCents(k.priceTo)}</td><td className="r">{formatCents(k.priceToWithoutPair)}</td></tr>
            ))}
          </tbody>
        </table>
        {tickers.map((t) => <PriceChart key={t} points={report.series} ticker={t} />)}
      </Card>

      <Card title={open ? "Efeito de anular os marcados" : "Patrimônio e posição, com e sem os negócios"}>
        <ErrorNote message={previewAction.error} />
        <table className="tbl">
          <thead><tr><th>Mês</th><th>Conta</th><th className="r">Patrimônio com</th><th className="r">Patrimônio sem</th><th className="r">Posição com</th><th className="r">Posição sem</th></tr></thead>
          <tbody>
            {report.months.flatMap((m) =>
              m.accounts.map((a) => (
                <tr key={`${m.month}-${a.walletId}`}>
                  <td>{m.month}{m.open ? " (agora)" : ""}</td>
                  <td>{detail.parties.find((p) => p.walletId === a.walletId)?.label ?? "conta excluída"}</td>
                  <td className="r">{formatCents(a.equity)}</td><td className="r">{formatCents(a.equityWithout)}</td>
                  <td className="r">{a.rank ?? "—"}</td><td className="r">{a.rankWithout ?? "—"}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </Card>

      <Card title="Negócios das duas contas com outros jogadores (valem, não são anulados)">
        {detail.report.others.length === 0 ? (
          <p className="m0 muted">Nenhum no período.</p>
        ) : (
          <table className="tbl">
            <thead><tr><th>Quando</th><th>Clube</th><th>Conta</th><th>Lado</th><th className="r">Ações</th><th className="r">Preço</th></tr></thead>
            <tbody>
              {detail.report.others.map((o) => (
                <tr key={`${o.id}-${o.walletId}`}><td>{formatInstant(o.at)}</td><td>{o.ticker}</td><td>{detail.parties.find((p) => p.walletId === o.walletId)?.label ?? "conta excluída"}</td><td>{o.side === "buy" ? "compra" : "venda"}</td><td className="r">{formatInt(o.quantity)}</td><td className="r">{formatCents(o.price)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {open && <DecisionCard admin={admin} id={id} selected={selected} onDecided={async (r) => { setResult(r); await loader.reload(); }} onDismissed={loader.reload} />}
      {result && <BanOffers admin={admin} id={id} result={result} />}
    </div>
  );
}

function DownloadButton({ admin, id }: { admin: AdminApi; id: number }) {
  const action = useAction();
  const go = () =>
    action.run(async () => {
      const html = await admin.fraudReportFile(id);
      const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `relatorio-trapaca-${id}.html`;
      a.click();
      URL.revokeObjectURL(url);
    });
  return (
    <span>
      <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => void go()}>Baixar o relatório</button>
      <ErrorNote message={action.error} />
    </span>
  );
}

function DecisionCard({ admin, id, selected, onDecided, onDismissed }: { admin: AdminApi; id: number; selected: Set<number>; onDecided(r: ConfirmFraudResponse): Promise<void>; onDismissed(): Promise<void> }) {
  const [reason, setReason] = useState("");
  const action = useAction();
  // a mesma chave até dar certo: o clique duplo não anula duas vezes
  const key = useRef<string>(crypto.randomUUID());
  const valid = reasonFeedback(reason).ok;
  const confirm = async () => {
    let done: ConfirmFraudResponse | null = null;
    if (await action.run(async () => { done = await admin.confirmFraud(id, { tradeIds: [...selected].sort((a, b) => a - b), reason }, key.current); })) {
      key.current = crypto.randomUUID();
      if (done) await onDecided(done);
    }
  };
  const dismiss = async () => {
    if (await action.run(() => admin.dismissFraud(id, { reason }))) await onDismissed();
  };
  return (
    <Card title="Decidir">
      <div className="stack-s">
        <div className="note"><div>O motivo vai para o aviso do jogador e para o registro do admin. <strong>Não cite a outra conta no motivo</strong>: o jogador nunca vê a contraparte.</div></div>
        <ReasonField value={reason} onChange={setReason} id="motivo-trapaca" />
        <ErrorNote message={action.error} />
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-d" disabled={!valid || selected.size === 0 || action.busy} onClick={() => void confirm()}>
            Confirmar e anular {selected.size} negócio{selected.size === 1 ? "" : "s"}
          </button>
          <button type="button" className="btn" disabled={!valid || action.busy} onClick={() => void dismiss()}>Descartar o caso</button>
        </div>
        <span className="xs muted">Confirmar devolve as ações e o dinheiro, refaz o preço do clube, avisa as duas contas e dá uma advertência a cada jogador. Descartar só fecha o caso.</span>
      </div>
    </Card>
  );
}

function BanOffers({ admin, id, result }: { admin: AdminApi; id: number; result: ConfirmFraudResponse }) {
  return (
    <Card title="Negócios anulados">
      <div className="stack-s">
        <p className="m0">{result.annulled.length} negócio(s) anulado(s). As duas contas foram avisadas.</p>
        {result.banOffer.length > 0 && <p className="m0 b">Reincidência: estas contas já tinham uma advertência. Você pode bani-las (o bloqueio pode ser desfeito depois).</p>}
        {result.banOffer.map((o) => <BanOffer key={o.userId} admin={admin} id={id} userId={o.userId} label={o.label} warnings={o.previousWarnings} />)}
      </div>
    </Card>
  );
}

function BanOffer({ admin, id, userId, label, warnings }: { admin: AdminApi; id: number; userId: string; label: string; warnings: number }) {
  const [reason, setReason] = useState("");
  const [done, setDone] = useState(false);
  const action = useAction();
  if (done) return <p className="m0">{label} foi banida (conta bloqueada).</p>;
  return (
    <div className="stack-s">
      <span>{label} · {warnings} advertência{warnings > 1 ? "s" : ""} antes deste caso</span>
      <ReasonField value={reason} onChange={setReason} id={`motivo-ban-${userId}`} label={`Motivo do banimento de ${label}`} />
      <ErrorNote message={action.error} />
      <button type="button" className="btn btn-d" disabled={!reasonFeedback(reason).ok || action.busy} onClick={() => void action.run(() => admin.banFraud(id, { userId, reason })).then((ok) => ok && setDone(true))}>
        Banir {label}
      </button>
    </div>
  );
}
