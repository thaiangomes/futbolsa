"use client";

import { useEffect, useState } from "react";
import type { AdminApi } from "./api";
import { ACTION_LABELS, formatInstant } from "./forms";
import { Card, LoadState, useLoader } from "./ui";

const asJson = (value: unknown) => (value === null || value === undefined ? "—" : JSON.stringify(value, null, 1));

/** O registro do admin: filtros por ação, autor e período, o antes e o depois lado a lado (Admin, critério 33). */
export function LogScreen({ admin }: { admin: AdminApi }) {
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const filters = {
    page,
    pageSize: 25,
    ...(action ? { action } : {}),
    ...(actorId.trim() ? { actorId: actorId.trim() } : {}),
    ...(from ? { from: new Date(`${from}T00:00:00-03:00`).toISOString() } : {}),
    ...(to ? { to: new Date(`${to}T00:00:00-03:00`).toISOString() } : {}),
  };
  const key = JSON.stringify(filters);
  const loader = useLoader(() => admin.log(filters));
  // Recarrega quando os filtros mudam.
  const { reload } = loader;
  useEffect(() => {
    void reload();
  }, [key, reload]);
  const data = loader.data;
  const change = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(1);
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="stack">
      <Card title="Filtros">
        <div className="g-3">
          <div className="field">
            <label htmlFor="acao">Ação</label>
            <select id="acao" className="input" value={action} onChange={(e) => change(setAction)(e.target.value)}>
              <option value="">Todas</option>
              {Object.entries(ACTION_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="autor">Autor (id)</label>
            <input id="autor" className="input" value={actorId} onChange={(e) => change(setActorId)(e.target.value)} />
          </div>
          <div className="row">
            <div className="field"><label htmlFor="de">De</label><input id="de" className="input" type="date" value={from} onChange={(e) => change(setFrom)(e.target.value)} /></div>
            <div className="field"><label htmlFor="ate">Até (exclusive)</label><input id="ate" className="input" type="date" value={to} onChange={(e) => change(setTo)(e.target.value)} /></div>
          </div>
        </div>
      </Card>
      <LoadState loader={loader} />
      {data && (
        <Card title={`${data.total} registro(s)`}>
          {data.entries.length === 0 ? (
            <p className="m0 muted">Nada no período.</p>
          ) : (
            <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {data.entries.map((e) => (
                <li key={e.id} className="card" style={{ padding: 12 }}>
                  <div className="row between">
                    <span className="b">{ACTION_LABELS[e.action] ?? e.action}</span>
                    <span className="small muted">{formatInstant(e.at)} · {e.actor.nickname ?? "conta excluída"}</span>
                  </div>
                  {e.reason && <p className="small" style={{ margin: "6px 0" }}>Motivo: {e.reason}</p>}
                  <div className="g-2">
                    <div><div className="xs muted">Antes</div><pre className="small m0" style={{ whiteSpace: "pre-wrap" }}>{asJson(e.before)}</pre></div>
                    <div><div className="xs muted">Depois</div><pre className="small m0" style={{ whiteSpace: "pre-wrap" }}>{asJson(e.after)}</pre></div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="row between" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button>
            <span className="small muted">Página {page} de {pages}</span>
            <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        </Card>
      )}
    </div>
  );
}
