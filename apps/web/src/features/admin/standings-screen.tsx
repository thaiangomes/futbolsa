"use client";

import { useState } from "react";
import type { StandingsCompetition, StandingsView } from "@futbolsa/contracts";
import type { AdminApi } from "./api";
import { COMPETITION_LABELS, differsFromSource, formatInstant, moveInOrder, reasonFeedback } from "./forms";
import { Card, ErrorNote, LoadState, ReasonField, useAction, useLoader } from "./ui";

function Table({ view, admin, onChanged }: { view: StandingsView; admin: AdminApi; onChanged(): Promise<void> }) {
  const initial = view.rows.map((r) => r.club.id);
  const [order, setOrder] = useState(initial);
  const [reason, setReason] = useState("");
  const action = useAction();
  const byId = new Map(view.rows.map((r) => [r.club.id, r]));
  const changed = order.some((id, i) => id !== initial[i]);
  const differing = new Set(differsFromSource(view.rows));
  const competition: StandingsCompetition = view.competition;

  if (view.rows.length === 0) {
    return <p className="m0 muted">Ainda sem tabela importada. Use "Importar agora" na tela de jogos.</p>;
  }
  const save = async () => {
    if (await action.run(() => admin.correctStandings(competition, order, reason))) {
      setReason("");
      await onChanged();
    }
  };
  const confirm = async () => {
    if (await action.run(() => admin.confirmStandings(competition))) await onChanged();
  };
  return (
    <div className="stack-s">
      <div className="row between">
        <span className="small muted">
          {view.confirmedAt ? `Conferida por ${view.confirmedBy ?? "admin"} em ${formatInstant(view.confirmedAt)}` : "Ainda não conferida: a F12 só paga colocação e acesso com a tabela conferida."}
          {view.manualOverride && " · ordem corrigida pelo admin"}
        </span>
        <button type="button" className="btn btn-p btn-sm" disabled={action.busy || changed || view.confirmedAt !== null} onClick={() => void confirm()}>
          Conferir
        </button>
      </div>
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Pos.</th><th>Clube</th><th className="r">Pontos</th><th>Fonte</th><th className="c">Mover</th></tr></thead>
          <tbody>
            {order.map((id, i) => {
              const row = byId.get(id)!;
              const diff = row.sourcePosition !== null && row.sourcePosition !== i + 1;
              return (
                <tr key={id} className={differing.has(i) && !changed ? "me" : undefined}>
                  <td className="num">{i + 1}</td>
                  <td>{row.club.name} {row.club.ticker ? <span className="chip">{row.club.ticker}</span> : <span className="chip chip-bot">não listado</span>}</td>
                  <td className="r num">{row.points}</td>
                  <td className="small muted">{row.sourcePosition === null ? "—" : diff ? `a fonte diz ${row.sourcePosition}º` : "igual"}</td>
                  <td className="c">
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Subir ${row.club.name}`} disabled={i === 0} onClick={() => setOrder(moveInOrder(order, id, -1))}>▲</button>
                    <button type="button" className="btn btn-ghost btn-sm" aria-label={`Descer ${row.club.name}`} disabled={i === order.length - 1} onClick={() => setOrder(moveInOrder(order, id, 1))}>▼</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {changed && (
        <div className="stack-s">
          <ReasonField value={reason} onChange={setReason} id={`motivo-${competition}`} label="Motivo da correção" />
          <ErrorNote message={action.error} />
          <div className="row">
            <button type="button" className="btn btn-p" disabled={!reasonFeedback(reason).ok || action.busy} onClick={() => void save()}>Salvar a correção</button>
            <button type="button" className="btn btn-ghost" onClick={() => { setOrder(initial); setReason(""); }}>Desfazer</button>
          </div>
        </div>
      )}
      {!changed && <ErrorNote message={action.error} />}
    </div>
  );
}

/** Classificação oficial da Série A e da Série B inteira: ordem da fonte, correção de posição com motivo e conferir. */
export function StandingsScreen({ admin }: { admin: AdminApi }) {
  const loader = useLoader(() => admin.standings());
  const data = loader.data;
  if (!data) return <LoadState loader={loader} />;
  return (
    <div className="stack">
      {data.standings.map((view) => (
        <Card key={`${view.competition}-${view.rows.map((r) => r.club.id).join(",")}-${view.confirmedAt}`} title={COMPETITION_LABELS[view.competition] ?? view.competition}>
          <Table view={view} admin={admin} onChanged={loader.reload} />
        </Card>
      ))}
    </div>
  );
}
