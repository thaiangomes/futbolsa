"use client";

import { type LiveRanking, type OfficialRanking, type RankingHistory, type RankingPeriodName, type RankingRow, rankingsLiveEventSchema } from "@futbolsa/contracts";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../accounts/session-provider";
import { useSyncedChannel } from "../../realtime/react";
import { type RankingsApi, rankingsApi } from "./api";
import { applyLiveEvent, monthFromSearch, monthLabel, positionLabel, returnLabel, rowName, searchForMonth } from "./ranking-state";

const PAGE = 50;

/** A página `/rankings` (prancha 4): parcial do mês e da temporada, meses fechados, campeões e "como é medido". */
export function RankingsScreen() {
  const { api, state } = useSession();
  const rankings = useMemo(() => rankingsApi(api), [api]);
  return <RankingsContent api={rankings} logged={state.status === "ready"} />;
}

type Tab = "live" | "closed";

/** O miolo da tela, sem depender da sessão (os testes passam a API). */
export function RankingsContent({ api, logged }: { api: RankingsApi; logged: boolean }) {
  const [tab, setTab] = useState<Tab>("live");
  const [month, setMonth] = useState<string | null>(null);

  // o mês escolhido volta da query ao recarregar (a exportação estática não tem rota por mês)
  useEffect(() => {
    const fromQuery = monthFromSearch(window.location.search);
    if (fromQuery) {
      setMonth(fromQuery);
      setTab("closed");
    }
  }, []);
  const pick = (key: string | null) => {
    setMonth(key);
    window.history.replaceState(null, "", `${window.location.pathname}${searchForMonth(key)}`);
  };

  return (
    <div className="stack">
      <div className="row" role="tablist" style={{ gap: 8 }}>
        <button role="tab" aria-selected={tab === "live"} className={tab === "live" ? "btn btn-p btn-sm" : "btn btn-ghost btn-sm"} onClick={() => setTab("live")}>
          Parcial
        </button>
        <button role="tab" aria-selected={tab === "closed"} className={tab === "closed" ? "btn btn-p btn-sm" : "btn btn-ghost btn-sm"} onClick={() => setTab("closed")}>
          Meses fechados
        </button>
      </div>
      {tab === "live" ? <LiveTab api={api} logged={logged} /> : <ClosedTab api={api} month={month} onPick={pick} />}
      <HowMeasured />
    </div>
  );
}

function HowMeasured() {
  return (
    <section className="card" aria-label="Como é medido">
      <div className="card-h"><h2 className="card-t">Como é medido</h2></div>
      <div className="card-b stack small">
        <p>O ranking é pela rentabilidade, não pelo tamanho da carteira: (patrimônio − base) ÷ base.</p>
        <p>O patrimônio é o caixa, mais as ações ao preço do último negócio, mais o que está a receber de dividendos e recompra. Ordens abertas não mudam o patrimônio.</p>
        <p>No mês, a base é o patrimônio do fechamento do mês anterior (23h59 de Brasília do último dia); no ano, R$ 100.000,00. Quem entra no meio do mês parte de R$ 100.000,00.</p>
        <p>Retornos exatamente iguais dividem a posição. Bloqueados e contas excluídas ficam fora da parcial; nos meses já fechados, a conta excluída aparece como &ldquo;conta excluída&rdquo;.</p>
      </div>
    </section>
  );
}

function PeriodToggle({ period, onChange }: { period: RankingPeriodName; onChange: (p: RankingPeriodName) => void }) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <button className={period === "month" ? "btn btn-p btn-sm" : "btn btn-ghost btn-sm"} aria-pressed={period === "month"} onClick={() => onChange("month")}>Mês</button>
      <button className={period === "season" ? "btn btn-p btn-sm" : "btn btn-ghost btn-sm"} aria-pressed={period === "season"} onClick={() => onChange("season")}>Temporada</button>
    </div>
  );
}

function NameCell({ row }: { row: RankingRow }) {
  return (
    <span className="row-s" style={{ gap: 8 }}>
      <span className={row.displayName || row.isBot ? "b" : "b muted"}>{rowName(row)}</span>
      {row.isBot && <span className="chip chip-bot">bot</span>}
    </span>
  );
}

/** O pódio: os três primeiros (com empate, mais de um por degrau). */
export function Podium({ rows }: { rows: readonly RankingRow[] }) {
  const top = rows.filter((r) => r.position <= 3);
  if (top.length === 0) return null;
  return (
    <div className="g-3" aria-label="Pódio">
      {top.map((r) => (
        <div key={r.walletKey} className="card" style={{ textAlign: "center" }}>
          <div className="card-b stack">
            <span className="disp" style={{ fontSize: 28 }}>{positionLabel(r.position)}</span>
            <NameCell row={r} />
            <span className="b">{returnLabel(r.returnBp)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RankingTable({ rows, me }: { rows: readonly RankingRow[]; me?: RankingRow | null }) {
  const mine = me?.walletKey;
  const shown = me && !rows.some((r) => r.walletKey === mine) ? [...rows, me] : rows;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="tbl">
        <thead><tr><th>Posição</th><th>Jogador</th><th className="r">Retorno</th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.walletKey} className={r.walletKey === mine ? "me" : undefined} data-testid={r.walletKey === mine ? "my-row" : undefined}>
              <td>{positionLabel(r.position)}</td>
              <td><NameCell row={r} />{r.walletKey === mine && <span className="chip chip-me" style={{ marginLeft: 8 }}>você</span>}</td>
              <td className="r b">{returnLabel(r.returnBp)}</td>
            </tr>
          ))}
          {shown.length === 0 && <tr><td colSpan={3} className="muted">Ninguém no ranking ainda.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Pager({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  if (total <= PAGE) return null;
  return (
    <div className="row between">
      <button className="btn btn-ghost btn-sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE))}>Anterior</button>
      <span className="small muted">{offset + 1}–{Math.min(offset + PAGE, total)} de {total}</span>
      <button className="btn btn-ghost btn-sm" disabled={offset + PAGE >= total} onClick={() => onChange(offset + PAGE)}>Próxima</button>
    </div>
  );
}

/** A parcial ao vivo: carrega pela REST, aplica o `rankings.live` (canal sincronizado) e relê a própria página de tempos em tempos quando há linha pessoal ou página além do topo. */
function LiveTab({ api, logged }: { api: RankingsApi; logged: boolean }) {
  const [period, setPeriod] = useState<RankingPeriodName>("month");
  const [offset, setOffset] = useState(0);
  return (
    <div className="stack">
      <PeriodToggle period={period} onChange={(p) => { setPeriod(p); setOffset(0); }} />
      <LivePanel key={`${period}:${offset}`} api={api} period={period} offset={offset} logged={logged} onOffset={setOffset} />
    </div>
  );
}

function LivePanel({ api, period, offset, logged, onOffset }: { api: RankingsApi; period: RankingPeriodName; offset: number; logged: boolean; onOffset: (o: number) => void }) {
  const synced = useSyncedChannel<LiveRanking>(
    "rankings",
    async () => {
      const state = await api.live(period, offset, PAGE);
      return { state, seq: state.seq };
    },
    (state, event) => {
      if (event.type !== "rankings.live") return state;
      const parsed = rankingsLiveEventSchema.safeParse(event.data);
      return parsed.success ? applyLiveEvent(state, parsed.data) : state;
    },
  );
  // a linha de quem pediu e as páginas além do topo não vêm no evento: a tela relê a REST a cada 15 s
  const [polled, setPolled] = useState<LiveRanking | null>(null);
  useEffect(() => {
    if (!logged && offset === 0) return;
    const timer = setInterval(() => {
      api.live(period, offset, PAGE).then(setPolled).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, [api, period, offset, logged]);

  const base = synced.state;
  const state = base && polled && Date.parse(polled.computedAt) > Date.parse(base.computedAt) ? { ...base, ...polled } : base;
  if (!state) return <p className="muted">{synced.status === "error" ? "Não foi possível carregar o ranking." : "Carregando…"}</p>;
  return (
    <div className="stack">
      <p className="small muted">
        {period === "month" ? `Parcial de ${monthLabel(state.periodKey)}` : `Parcial de ${state.periodKey}`}
        {" · "}calculada às {new Date(state.computedAt).toLocaleTimeString("pt-BR")}
        {state.botsIncluded ? " · com os bots" : ""}
      </p>
      {offset === 0 && <Podium rows={state.rows} />}
      <RankingTable rows={state.rows} me={state.me} />
      <Pager offset={offset} total={state.total} onChange={onOffset} />
    </div>
  );
}

const championNames = (list: ReadonlyArray<{ displayName: string | null; botLabel: string | null }>): string =>
  list.map((c) => c.displayName ?? c.botLabel ?? "conta excluída").join(", ") || "—";

/** Os meses já fechados: seletor de temporada e de mês, cartão de campeões e o ranking oficial escolhido. */
function ClosedTab({ api, month, onPick }: { api: RankingsApi; month: string | null; onPick: (key: string | null) => void }) {
  const [history, setHistory] = useState<RankingHistory | null>(null);
  const [error, setError] = useState(false);
  const [year, setYear] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    api.history().then((h) => alive && setHistory(h)).catch(() => alive && setError(true));
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (!history) return;
    const fromMonth = month ? Number(month.slice(0, 4)) : null;
    setYear((current) => (fromMonth && history.seasons.some((s) => s.year === fromMonth) ? fromMonth : current ?? history.seasons[0]?.year ?? null));
  }, [history, month]);

  if (error) return <p className="muted">Não foi possível carregar os rankings fechados.</p>;
  if (!history) return <p className="muted">Carregando…</p>;
  if (history.seasons.length === 0) return <p className="muted">Nenhum mês foi fechado ainda.</p>;
  const season = history.seasons.find((s) => s.year === year) ?? history.seasons[0]!;
  const selected = month ?? season.months[season.months.length - 1]?.monthKey ?? null;
  return (
    <div className="stack">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <label className="small">Temporada{" "}
          <select className="input" value={season.year} onChange={(e) => { setYear(Number(e.target.value)); onPick(null); }}>
            {history.seasons.map((s) => <option key={s.year} value={s.year}>{s.year}</option>)}
          </select>
        </label>
        <label className="small">Mês{" "}
          <select className="input" value={selected ?? ""} onChange={(e) => onPick(e.target.value || null)} disabled={season.months.length === 0}>
            {season.months.map((m) => <option key={m.monthKey} value={m.monthKey}>{monthLabel(m.monthKey)}</option>)}
          </select>
        </label>
        {season.season && <button className="btn btn-ghost btn-sm" onClick={() => onPick(String(season.year))}>Ano {season.year}</button>}
      </div>
      <section className="card" aria-label="Campeões">
        <div className="card-h"><h2 className="card-t">Campeões</h2></div>
        <div className="card-b stack small">
          {season.season && (
            <button className="btn btn-ghost" onClick={() => onPick(String(season.year))}>
              <b>{season.year}</b>: {championNames(season.season.champions)}
            </button>
          )}
          {season.months.map((m) => (
            <button key={m.monthKey} className="btn btn-ghost" onClick={() => onPick(m.monthKey)}>
              <b>{monthLabel(m.monthKey)}</b>: {championNames(m.champions)}
            </button>
          ))}
        </div>
      </section>
      {selected && <OfficialPanel key={selected} api={api} keyName={selected} />}
    </div>
  );
}

function OfficialPanel({ api, keyName }: { api: RankingsApi; keyName: string }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<OfficialRanking | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setError(false);
    const call = /^\d{4}$/.test(keyName) ? api.season(keyName, offset, PAGE) : api.month(keyName, offset, PAGE);
    call.then((d) => alive && setData(d)).catch(() => alive && setError(true));
    return () => { alive = false; };
  }, [api, keyName, offset]);
  if (error) return <p className="muted">Não foi possível carregar este ranking.</p>;
  if (!data) return <p className="muted">Carregando…</p>;
  return (
    <div className="stack">
      <p className="small muted">
        {data.period === "month" ? monthLabel(data.periodKey) : `Temporada ${data.periodKey}`} · fechado em {new Date(data.closedAt).toLocaleDateString("pt-BR")}
        {data.version > 1 ? ` · versão ${data.version} (recalculado)` : ""}
        {data.botsIncluded ? " · com os bots" : ""}
      </p>
      {offset === 0 && <Podium rows={data.rows} />}
      <RankingTable rows={data.rows} />
      <Pager offset={offset} total={data.total} onChange={setOffset} />
    </div>
  );
}
