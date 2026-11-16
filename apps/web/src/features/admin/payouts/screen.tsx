"use client";

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { PayoutEventView, PayoutHoldersResponse } from "@futbolsa/contracts";
import type { AdminApi } from "../api";
import { COMPETITION_LABELS, formatCents, formatInstant } from "../forms";
import { Card, ErrorNote, LoadState, useAction, useLoader } from "../ui";
import { anySettling, approvalSummary, canApprove, DEFAULT_PAYOUT_FILTERS, eventState, groupEvents, KIND_LABELS, pageCount, type PayoutFilters, payoutQuery } from "./model";

const POLL_MS = 3000;
type ApproveBody = Parameters<AdminApi["approvePayouts"]>[0];

/**
 * Pagamentos aguardando e prévia (prancha 7a; Admin, critérios 2 a 4, 31 e 33): os eventos vigentes agrupados por
 * rodada ou fase, com o valor por ação, as ações da foto e o total; aprovar um, os do grupo ou todos (com
 * confirmação, porque o dinheiro sai); o aviso de classificação não conferida, que bloqueia a colocação e o acesso;
 * e o "liquidando" com o progresso dos lotes, que a tela acompanha sozinha até acabar.
 */
export function PayoutsScreen({ admin }: { admin: AdminApi }) {
  // a lista é filtrada e paginada na API; o filtro "só aguardando aprovação" abre ligado
  const [filters, setFilters] = useState<PayoutFilters>(DEFAULT_PAYOUT_FILTERS);
  const [page, setPage] = useState(1);
  const queryKey = JSON.stringify(payoutQuery(filters, page));
  const loader = useLoader(() => admin.payouts(payoutQuery(filters, page)));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void loader.reload();
  }, [queryKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const action = useAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [owners, setOwners] = useState<number | null>(null);
  const events = loader.data?.events ?? null;
  const settling = events ? anySettling(events) : false;

  useEffect(() => {
    if (!settling) return;
    const timer = setInterval(() => void loader.reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [settling, loader]);

  if (!events) return <LoadState loader={loader} />;
  const groups = groupEvents(events);
  const approvable = events.filter(canApprove);
  const pendingTotal = loader.data?.pendingTotal ?? 0;
  const total = loader.data?.total ?? 0;
  const pageSize = loader.data?.pageSize ?? 50;
  const last = pageCount(total, pageSize);

  const approve = async (body: ApproveBody) => {
    setSummary(null);
    const ok = await action.run(async () => {
      setSummary(approvalSummary(await admin.approvePayouts(body)));
    });
    // o evento pode ter sido substituído no meio: mostra o que há agora
    await loader.reload();
    setConfirming(null);
    return ok;
  };

  const confirmBar = (label: string, body: ApproveBody) => (
    <span className="row-s" role="group" aria-label="Confirmar aprovação">
      <span className="small">{label}</span>
      <button type="button" className="btn btn-p" disabled={action.busy} onClick={() => void approve(body)}>Confirmar</button>
      <button type="button" className="btn" disabled={action.busy} onClick={() => setConfirming(null)}>Voltar</button>
    </span>
  );

  return (
    <div className="stack">
      <Card
        title="Pagamentos de dividendos"
        right={
          confirming === "all" ? (
            confirmBar(`Aprovar ${pendingTotal} ${pendingTotal === 1 ? "evento" : "eventos"}, de todas as páginas e sem filtro?`, { all: true })
          ) : (
            <button type="button" className="btn btn-p" disabled={pendingTotal === 0 || action.busy} onClick={() => setConfirming("all")}>
              Aprovar todos os aguardando ({pendingTotal})
            </button>
          )
        }
      >
        <p className="small muted m0">
          Aprovar credita o dinheiro na carteira de quem tinha as ações no fechamento do evento. Os créditos saem em lotes, em segundo plano. Colocação e acesso só saem depois de conferir a classificação oficial.
        </p>
      </Card>
      <FilterBar
        applied={filters}
        onApply={(f) => {
          setFilters(f);
          setPage(1);
        }}
      />
      <ErrorNote message={action.error} />
      {summary && <div className="note note-ok" role="status"><div>{summary}</div></div>}
      {groups.length === 0 && (
        <p className="muted" data-testid="sem-pagamentos">
          {JSON.stringify(filters) === JSON.stringify(DEFAULT_PAYOUT_FILTERS)
            ? "Nenhum pagamento aguardando por enquanto. Eles aparecem quando uma rodada ou fase fecha."
            : "Nenhum pagamento com estes filtros."}
        </p>
      )}
      {groups.map((g) => {
        const ids = g.events.filter(canApprove).map((e) => e.id);
        const key = `group:${g.label}`;
        return (
          <Card
            key={g.label}
            title={g.label}
            right={
              <span className="row-s">
                <span className="xs muted">{g.events.length} eventos · {formatCents(g.total)}</span>
                {ids.length > 0 &&
                  (confirming === key ? (
                    confirmBar(`Aprovar ${ids.length} do grupo?`, { eventIds: ids.slice(0, 500) })
                  ) : (
                    <button type="button" className="btn" disabled={action.busy} onClick={() => setConfirming(key)}>Aprovar o grupo ({ids.length})</button>
                  ))}
              </span>
            }
          >
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Clube</th><th>Tipo</th><th>Motivo</th><th className="r">Por ação</th><th className="r">Ações</th><th className="r">Total</th><th>Fechamento</th><th>Situação</th><th />
                  </tr>
                </thead>
                <tbody>
                  {g.events.map((e) => (
                    <EventRow
                      key={e.id}
                      e={e}
                      busy={action.busy}
                      confirming={confirming === `event:${e.id}`}
                      onAsk={() => setConfirming(`event:${e.id}`)}
                      confirmBar={() => confirmBar("Aprovar?", { eventIds: [e.id] })}
                      owners={owners === e.id}
                      onOwners={() => setOwners(owners === e.id ? null : e.id)}
                      admin={admin}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
      <div className="row between" data-testid="paginacao">
        <span className="xs muted">{total} {total === 1 ? "evento" : "eventos"} · página {page} de {last}</span>
        <span className="row-s">
          <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <button type="button" className="btn" disabled={page >= last} onClick={() => setPage(page + 1)}>Próxima</button>
        </span>
      </div>
    </div>
  );
}

/**
 * Os filtros da lista (Admin, critério 47): "só aguardando aprovação" (ligado ao abrir), tipo, competição, clube e período do
 * fechamento. Os campos só valem ao clicar em Filtrar, para não pedir à API a cada letra.
 */
function FilterBar({ applied, onApply }: { applied: PayoutFilters; onApply(f: PayoutFilters): void }) {
  const [draft, setDraft] = useState<PayoutFilters>(applied);
  const set = <K extends keyof PayoutFilters>(k: K, v: PayoutFilters[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply(draft);
  };
  return (
    <form className="card card-b row-s" style={{ flexWrap: "wrap", alignItems: "flex-end" }} onSubmit={submit} aria-label="Filtros dos pagamentos" data-testid="filtros">
      <label className="row-s small">
        <input type="checkbox" checked={draft.onlyPending} onChange={(e) => set("onlyPending", e.target.checked)} />
        Só aguardando aprovação
      </label>
      <label className="stack-s small">Tipo
        <select value={draft.kind} onChange={(e) => set("kind", e.target.value)}>
          <option value="">Todos</option>
          {Object.entries(KIND_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="stack-s small">Competição
        <select value={draft.competition} onChange={(e) => set("competition", e.target.value)}>
          <option value="">Todas</option>
          {Object.entries(COMPETITION_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </label>
      <label className="stack-s small">Clube
        <input type="text" value={draft.club} maxLength={10} placeholder="FLA3" style={{ width: 90 }} onChange={(e) => set("club", e.target.value)} />
      </label>
      <label className="stack-s small">Fechamento de
        <input type="date" value={draft.from} onChange={(e) => set("from", e.target.value)} />
      </label>
      <label className="stack-s small">até
        <input type="date" value={draft.to} onChange={(e) => set("to", e.target.value)} />
      </label>
      <button type="submit" className="btn btn-p">Filtrar</button>
      <button
        type="button"
        className="btn"
        onClick={() => {
          setDraft(DEFAULT_PAYOUT_FILTERS);
          onApply(DEFAULT_PAYOUT_FILTERS);
        }}
      >
        Restaurar padrão
      </button>
    </form>
  );
}

function EventRow(props: {
  e: PayoutEventView;
  busy: boolean;
  confirming: boolean;
  onAsk(): void;
  confirmBar(): ReactNode;
  owners: boolean;
  onOwners(): void;
  admin: AdminApi;
}) {
  const { e } = props;
  const state = eventState(e);
  return (
    <>
      <tr>
        <td className="b">{e.club.ticker ?? e.club.name}</td>
        <td>{KIND_LABELS[e.kind]}</td>
        <td className="small">{e.reason}</td>
        <td className="r">{formatCents(e.perShare)}</td>
        <td className="r">{e.shares.total.toLocaleString("pt-BR")}</td>
        <td className="r b">{formatCents(e.total)}</td>
        <td className="small">{formatInstant(e.closedAt)}</td>
        <td><span className={state.chip}>{state.label}</span></td>
        <td className="r">
          <span className="row-s" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" aria-expanded={props.owners} onClick={props.onOwners}>Donos</button>
            {canApprove(e) && (props.confirming ? props.confirmBar() : <button type="button" className="btn btn-p" disabled={props.busy} onClick={props.onAsk}>Aprovar</button>)}
          </span>
        </td>
      </tr>
      {state.kind === "blocked" && (
        <tr><td colSpan={9}><div className="note note-err" role="alert"><div>Confira a classificação oficial antes de aprovar: o valor depende da posição final.</div></div></td></tr>
      )}
      {props.owners && <tr><td colSpan={9}><Holders admin={props.admin} eventId={e.id} /></td></tr>}
    </>
  );
}

/** Os donos da foto do evento, 50 por página: carteira, ações, o que recebe e o que já foi creditado. */
function Holders({ admin, eventId }: { admin: AdminApi; eventId: number }) {
  const [page, setPage] = useState(1);
  const loader = useLoader<PayoutHoldersResponse>(() => admin.payoutHolders(eventId, page));
  useEffect(() => {
    void loader.reload();
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = loader.data;
  if (!data) return <LoadState loader={loader} />;
  const last = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <div className="stack-s">
      <table className="tbl">
        <thead><tr><th>Dono</th><th className="r">Ações</th><th className="r">Recebe</th><th className="r">Creditado</th></tr></thead>
        <tbody>
          {data.holders.map((h) => (
            <tr key={h.walletId}>
              <td>{h.kind === "bot" ? `bot ${h.nickname ?? ""}`.trim() : h.kind === "deleted" ? "conta excluída (não recebe)" : (h.nickname ?? `carteira ${h.walletId}`)}</td>
              <td className="r">{h.shares.toLocaleString("pt-BR")}</td>
              <td className="r">{formatCents(h.amount)}</td>
              <td className="r">{h.credited === null ? "—" : formatCents(h.credited)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row between">
        <span className="xs muted">{data.total} donos · página {page} de {last}</span>
        <span className="row-s">
          <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
          <button type="button" className="btn" disabled={page >= last} onClick={() => setPage(page + 1)}>Próxima</button>
        </span>
      </div>
    </div>
  );
}
