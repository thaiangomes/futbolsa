"use client";

import { useEffect, useState } from "react";
import type { AdminMatch, CompetitionCode } from "@futbolsa/contracts";
import { useChannel } from "../../realtime/react";
import type { AdminApi } from "./api";
import { COMPETITION_LABELS, formatInstant, reasonFeedback } from "./forms";
import { Card, ErrorNote, LoadState, ReasonField, useAction, useLoader } from "./ui";

const STATUS_LABELS: Record<string, string> = { scheduled: "agendado", finished: "encerrado", postponed: "adiado", cancelled: "cancelado" };
const label = (m: AdminMatch) => `${m.home.ticker ?? m.home.name} × ${m.away.ticker ?? m.away.name}`;
const where = (m: AdminMatch) => (m.round !== null ? `rodada ${m.round}` : (m.phase ?? "—"));

/** Edita um jogo: placar, estado (adiado, cancelado), quem passou, tudo com motivo obrigatório. */
function MatchEditor({ match, admin, onDone }: { match: AdminMatch; admin: AdminApi; onDone(): Promise<void> }) {
  const [home, setHome] = useState(match.homeGoals?.toString() ?? "");
  const [away, setAway] = useState(match.awayGoals?.toString() ?? "");
  const [status, setStatus] = useState<AdminMatch["status"]>(match.status);
  const [advanced, setAdvanced] = useState(match.advancedClubId?.toString() ?? "");
  const [reason, setReason] = useState("");
  const action = useAction();
  const isCup = match.round === null;
  const filled = home !== "" && away !== "";
  const goalsValid = (v: string) => /^\d{1,2}$/.test(v);
  const scoreOk = status !== "finished" || (goalsValid(home) && goalsValid(away));
  const canSave = reasonFeedback(reason).ok && scoreOk && !action.busy;

  const save = async () => {
    const body: Parameters<AdminApi["patchMatch"]>[1] = { reason: reason.trim() };
    if (status === "finished") {
      body.status = "finished";
      body.homeGoals = Number(home);
      body.awayGoals = Number(away);
      if (isCup && advanced) body.advancedClubId = Number(advanced);
    } else {
      body.status = status;
    }
    if (await action.run(() => admin.patchMatch(match.id, body))) await onDone();
  };

  return (
    <form className="stack-s" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}>
      <div className="row">
        <div className="field" style={{ width: 90 }}>
          <label htmlFor={`g-h-${match.id}`}>Gols {match.home.ticker ?? ""}</label>
          <input id={`g-h-${match.id}`} className="input" inputMode="numeric" value={home} onChange={(e) => { setHome(e.target.value); if (e.target.value && status !== "finished") setStatus("finished"); }} />
        </div>
        <div className="field" style={{ width: 90 }}>
          <label htmlFor={`g-a-${match.id}`}>Gols {match.away.ticker ?? ""}</label>
          <input id={`g-a-${match.id}`} className="input" inputMode="numeric" value={away} onChange={(e) => { setAway(e.target.value); if (e.target.value && status !== "finished") setStatus("finished"); }} />
        </div>
        <div className="field">
          <label htmlFor={`st-${match.id}`}>Estado</label>
          <select id={`st-${match.id}`} className="input" value={status} onChange={(e) => setStatus(e.target.value as AdminMatch["status"])}>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {isCup && status === "finished" && (
          <div className="field">
            <label htmlFor={`adv-${match.id}`}>Quem passou</label>
            <select id={`adv-${match.id}`} className="input" value={advanced} onChange={(e) => setAdvanced(e.target.value)}>
              <option value="">—</option>
              <option value={match.home.id}>{match.home.name}</option>
              <option value={match.away.id}>{match.away.name}</option>
            </select>
          </div>
        )}
      </div>
      {status === "finished" && !filled && <span className="hint err">Informe o placar dos dois clubes.</span>}
      <ReasonField value={reason} onChange={setReason} id={`motivo-${match.id}`} />
      <ErrorNote message={action.error} />
      <button type="submit" className="btn btn-p btn-sm" disabled={!canSave}>Salvar</button>
    </form>
  );
}

/** Cadastra um jogo que a fonte não trouxe. */
function NewMatch({ admin, onDone }: { admin: AdminApi; onDone(): Promise<void> }) {
  const [competition, setCompetition] = useState<CompetitionCode>("brasileirao-a");
  const [unit, setUnit] = useState("");
  const [homeId, setHomeId] = useState("");
  const [awayId, setAwayId] = useState("");
  const [kickoff, setKickoff] = useState("");
  const [reason, setReason] = useState("");
  const action = useAction();
  const isLeague = competition === "brasileirao-a" || competition === "brasileirao-b";
  const ok = unit.trim() !== "" && /^\d+$/.test(homeId) && /^\d+$/.test(awayId) && homeId !== awayId && kickoff !== "" && reasonFeedback(reason).ok;
  const save = async () => {
    const created = await action.run(() =>
      admin.createMatch({
        competition,
        ...(isLeague ? { round: Number(unit) } : { phase: unit.trim() }),
        homeClubId: Number(homeId),
        awayClubId: Number(awayId),
        kickoff: new Date(kickoff).toISOString(),
        status: "scheduled",
        reason: reason.trim(),
      }),
    );
    if (created) {
      setUnit(""); setHomeId(""); setAwayId(""); setKickoff(""); setReason("");
      await onDone();
    }
  };
  return (
    <form className="stack-s" onSubmit={(e) => { e.preventDefault(); if (ok && !action.busy) void save(); }}>
      <div className="row">
        <div className="field"><label htmlFor="n-comp">Competição</label>
          <select id="n-comp" className="input" value={competition} onChange={(e) => setCompetition(e.target.value as CompetitionCode)}>
            {Object.entries(COMPETITION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></div>
        <div className="field"><label htmlFor="n-unit">{isLeague ? "Rodada" : "Fase"}</label><input id="n-unit" className="input" value={unit} onChange={(e) => setUnit(e.target.value)} /></div>
        <div className="field"><label htmlFor="n-home">Mandante (id do clube)</label><input id="n-home" className="input" value={homeId} onChange={(e) => setHomeId(e.target.value)} /></div>
        <div className="field"><label htmlFor="n-away">Visitante (id do clube)</label><input id="n-away" className="input" value={awayId} onChange={(e) => setAwayId(e.target.value)} /></div>
        <div className="field"><label htmlFor="n-kick">Início</label><input id="n-kick" className="input" type="datetime-local" value={kickoff} onChange={(e) => setKickoff(e.target.value)} /></div>
      </div>
      <ReasonField value={reason} onChange={setReason} id="n-motivo" />
      <ErrorNote message={action.error} />
      <button type="submit" className="btn btn-p btn-sm" disabled={!ok || action.busy}>Cadastrar jogo</button>
    </form>
  );
}

/**
 * Pendências e jogos (Admin, critérios 5, 6 e 8): os jogos sem placar depois do fim previsto e as rodadas
 * que eles impedem de fechar; a lista de jogos com a divergência da fonte; editar e cadastrar com motivo.
 */
export function MatchesScreen({ admin }: { admin: AdminApi }) {
  const [competition, setCompetition] = useState<CompetitionCode | "">("");
  const [onlyDiverging, setOnlyDiverging] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const pending = useLoader(() => admin.pending());
  const list = useLoader(() => admin.matches({ ...(competition ? { competition } : {}), ...(onlyDiverging ? { diverging: true } : {}) }));
  const importing = useAction();
  const [report, setReport] = useState<string | null>(null);
  useChannel("admin", { onEvent: (e) => e.type === "admin.pending" && void pending.reload() });
  const reloadList = list.reload;
  useEffect(() => {
    void reloadList();
  }, [competition, onlyDiverging, reloadList]);

  const reloadAll = async () => {
    setEditing(null);
    await Promise.all([pending.reload(), list.reload()]);
  };
  const runImport = async () => {
    setReport(null);
    const ok = await importing.run(async () => {
      const res = await admin.runImport(competition ? { competition } : {});
      const failed = res.reports.filter((r) => r.error);
      setReport(failed.length ? `Falhou: ${failed.map((r) => `${COMPETITION_LABELS[r.competition]} (${r.error})`).join("; ")}` : `Importado: ${res.reports.length} etapa(s) sem erro.`);
    });
    if (ok) await reloadAll();
  };
  const p = pending.data;

  return (
    <div className="stack">
      <Card
        title="Pendências"
        right={<button type="button" className="btn btn-sm" disabled={importing.busy} onClick={() => void runImport()}>Importar agora</button>}
      >
        {report && <div className="note"><div>{report}</div></div>}
        <ErrorNote message={importing.error} />
        <LoadState loader={pending} />
        {p && (p.matches.length === 0 ? <p className="m0">Nenhum jogo sem placar depois do fim previsto.</p> : (
          <div className="stack-s">
            {p.blocked.map((b) => (
              <div key={`${b.competition}-${b.round}-${b.phase}`} className="note note-live">
                <div>Não fecha: <b>{COMPETITION_LABELS[b.competition]}, {b.round !== null ? `rodada ${b.round}` : b.phase}</b> ({b.matchIds.length} jogo(s) sem placar).</div>
              </div>
            ))}
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {p.matches.map((m) => (
                <li key={m.matchId}>{m.homeTicker ?? m.homeName} × {m.awayTicker ?? m.awayName} · {formatInstant(m.kickoff)} · {COMPETITION_LABELS[m.competition]}</li>
              ))}
            </ul>
          </div>
        ))}
        {p && (
          <p className="xs muted" style={{ marginBottom: 0 }}>
            Última importação: {Object.entries(p.lastImports).map(([c, at]) => `${COMPETITION_LABELS[c]} ${formatInstant(at)}`).join(" · ")}
          </p>
        )}
      </Card>

      <Card title="Jogos">
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="field">
            <label htmlFor="f-comp">Competição</label>
            <select id="f-comp" className="input" value={competition} onChange={(e) => setCompetition(e.target.value as CompetitionCode | "")}>
              <option value="">Todas</option>
              {Object.entries(COMPETITION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <label className="ck"><input type="checkbox" checked={onlyDiverging} onChange={(e) => setOnlyDiverging(e.target.checked)} /> <span>Só os que divergem da fonte</span></label>
          <button type="button" className="btn btn-sm" onClick={() => void list.reload()}>Atualizar a lista</button>
        </div>
        <LoadState loader={list} />
        {list.data && (
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th>Jogo</th><th>Onde</th><th>Início</th><th>Placar</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {list.data.matches.map((m) => (
                  <tr key={m.id}>
                    <td>{label(m)}</td>
                    <td className="small">{COMPETITION_LABELS[m.competition]} · {where(m)}</td>
                    <td className="small">{formatInstant(m.kickoff)}</td>
                    <td className="num">
                      {m.homeGoals === null ? "—" : `${m.homeGoals} × ${m.awayGoals}`}
                      {m.diverges && m.sourceView && (
                        <span className="chip chip-down" title="O jogo foi editado à mão e a fonte diz outra coisa">
                          fonte: {m.sourceView.homeGoals === null ? "sem placar" : `${m.sourceView.homeGoals} × ${m.sourceView.awayGoals}`}
                        </span>
                      )}
                    </td>
                    <td>{STATUS_LABELS[m.status]}{m.outOfWindow ? " · fora da janela" : ""}{m.manualOverride ? " · do admin" : ""}</td>
                    <td><button type="button" className="btn btn-sm" onClick={() => setEditing(editing === m.id ? null : m.id)}>{editing === m.id ? "Fechar" : "Editar"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.data?.matches.filter((m) => m.id === editing).map((m) => (
          <div key={m.id} className="card" style={{ padding: 16, marginTop: 12 }}>
            <div className="b" style={{ marginBottom: 8 }}>Editar {label(m)}</div>
            <MatchEditor match={m} admin={admin} onDone={reloadAll} />
          </div>
        ))}
      </Card>

      <Card title="Cadastrar um jogo que a fonte não trouxe">
        <NewMatch admin={admin} onDone={reloadAll} />
      </Card>
    </div>
  );
}
