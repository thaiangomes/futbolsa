"use client";

import { useEffect, useState } from "react";
import type { ClubRef, CupView, SeasonView } from "@futbolsa/contracts";
import type { AdminApi } from "./api";
import { COMPETITION_LABELS, formatCents, formatInstant } from "./forms";
import { brasiliaInputToIso, isoToBrasiliaInput } from "./season/dates";
import { LeaguesCard } from "./season/leagues-card";
import { PostponeIpo } from "./season/postpone-ipo";
import { Card, ErrorNote, LoadState, useAction, useLoader } from "./ui";

const opened = (s: SeasonView) => s.status !== "preparing";

/** Oferta e data do primeiro jogo; as datas do IPO saem dela. Nada muda depois da abertura do IPO. */
function OfferCard({ season, admin, onDone }: { season: SeasonView; admin: AdminApi; onDone(): Promise<void> }) {
  const [offer, setOffer] = useState(season.offerSize?.toString() ?? "");
  // O campo é em hora de Brasília (-03:00), na ida e na volta, como o de adiar o fechamento do IPO.
  const [kickoff, setKickoff] = useState(season.firstKickoff ? isoToBrasiliaInput(season.firstKickoff) : "");
  const action = useAction();
  const locked = opened(season);
  const offerOk = /^[1-9]\d*$/.test(offer);
  const kickoffIso = brasiliaInputToIso(kickoff);
  const save = async () => {
    if (await action.run(() => admin.patchSeason(season.id, { offerSize: Number(offer), ...(kickoffIso ? { firstKickoff: kickoffIso } : {}) }))) await onDone();
  };
  return (
    <Card title="Oferta e datas do IPO">
      {locked && <div className="note note-live" style={{ marginBottom: 12 }}><div>O IPO já abriu: a oferta e as datas não mudam mais.</div></div>}
      <form className="stack-s" onSubmit={(e) => { e.preventDefault(); if (offerOk && !locked) void save(); }}>
        <div className="row">
          <div className="field"><label htmlFor="oferta">Tamanho da oferta (ações por clube)</label><input id="oferta" className="input" inputMode="numeric" disabled={locked} value={offer} onChange={(e) => setOffer(e.target.value)} /></div>
          <div className="field"><label htmlFor="primeiro">Primeiro jogo da 1ª rodada (horário de Brasília)</label><input id="primeiro" className="input" type="datetime-local" disabled={locked} value={kickoff} onChange={(e) => setKickoff(e.target.value)} /></div>
        </div>
        <div className="g-3 small">
          <div className="kv"><span>Abertura das ofertas</span><span>{formatInstant(season.ipoOpensAt)}</span></div>
          <div className="kv"><span>Fechamento</span><span>{formatInstant(season.ipoClosesAt)}</span></div>
          <div className="kv"><span>Negociação abre</span><span>{formatInstant(season.tradingOpensAt)}</span></div>
        </div>
        <ErrorNote message={action.error} />
        <button type="submit" className="btn btn-p btn-sm" disabled={locked || !offerOk || action.busy}>Salvar</button>
      </form>
    </Card>
  );
}

/** Uma copa: tabela de fases e valores, avisos das regras (não bloqueiam) e confirmar. */
function CupCard({ seasonId, cup, locked, admin, onDone }: { seasonId: number; cup: CupView; locked: boolean; admin: AdminApi; onDone(): Promise<void> }) {
  const [values, setValues] = useState(cup.phases.map((p) => p.perShare.toString()));
  const action = useAction();
  const edited = values.some((v, i) => v !== cup.phases[i]!.perShare.toString());
  const valid = values.every((v) => /^\d+$/.test(v));
  const save = async () => {
    if (await action.run(() => admin.putCup(seasonId, cup.competition, { phases: cup.phases.map((p, i) => ({ ...p, perShare: Number(values[i]) })) }))) await onDone();
  };
  const confirm = async () => {
    if (await action.run(() => admin.confirmCup(seasonId, cup.competition))) await onDone();
  };
  return (
    <Card
      title={COMPETITION_LABELS[cup.competition] ?? cup.competition}
      right={cup.confirmedAt ? <span className="chip chip-up">Confirmada por {cup.confirmedBy ?? "admin"}</span> : <span className="chip chip-down">Não confirmada</span>}
    >
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Fase</th><th>Tipo</th><th className="r">Centavos por ação</th><th className="r">Em reais</th></tr></thead>
          <tbody>
            {cup.phases.map((p, i) => (
              <tr key={`${p.phaseKey}-${p.variant}`}>
                <td>{p.phaseKey}</td>
                <td className="small muted">{p.variant === "title" ? "título" : p.variant === "advance" ? "avançar" : `avançar para ${p.variant.slice(3)}`}</td>
                <td className="r"><input aria-label={`${p.phaseKey} ${p.variant}`} className="input" style={{ width: 100, height: 32, textAlign: "right" }} inputMode="numeric" disabled={locked} value={values[i]} onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))} /></td>
                <td className="r num">{valid ? formatCents(Number(values[i])) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cup.violations.length > 0 && (
        <div className="note note-live" role="status" style={{ marginTop: 12 }}>
          <div>
            <b>Avisos sobre a tabela</b> (não impedem de confirmar):
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{cup.violations.map((v) => <li key={v.code + v.message}>{v.message}</li>)}</ul>
          </div>
        </div>
      )}
      {cup.phasesWithoutValue.length > 0 && (
        <div className="note" style={{ marginTop: 8 }}><div>Há jogos nestas fases, que a tabela não paga: {cup.phasesWithoutValue.join(", ")}.</div></div>
      )}
      <ErrorNote message={action.error} />
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-sm" disabled={locked || !edited || !valid || action.busy} onClick={() => void save()}>Salvar a tabela</button>
        <button type="button" className="btn btn-p btn-sm" disabled={locked || edited || action.busy || cup.confirmedAt !== null} onClick={() => void confirm()}>Confirmar a tabela</button>
      </div>
    </Card>
  );
}

/** Clubes da temporada: os 20 da Série A com a colocação anterior (ordem única de 1 a 24) e a Série B do Clube dos Treze. */
function ClubsCard({ season, listed, known, admin, onDone }: { season: SeasonView; listed: Array<{ club: ClubRef; division: "A" | "B"; prevPlacement: number | null }>; known: ClubRef[]; admin: AdminApi; onDone(): Promise<void> }) {
  const [rows, setRows] = useState(() => new Map(listed.map((l) => [l.club.id, { division: l.division, placement: l.prevPlacement?.toString() ?? "" }])));
  const action = useAction();
  const locked = opened(season);
  const inA = [...rows.values()].filter((r) => r.division === "A").length;
  const placements = [...rows.values()].filter((r) => r.division === "A").map((r) => r.placement);
  const placementsOk = placements.every((p) => /^([1-9]|1\d|2[0-4])$/.test(p)) && new Set(placements).size === placements.length;
  const ok = inA === 20 && placementsOk;
  const toggle = (id: number, division: "A" | "B" | null) => {
    const next = new Map(rows);
    if (division === null) next.delete(id);
    else next.set(id, { division, placement: next.get(id)?.placement ?? "" });
    setRows(next);
  };
  const save = async () => {
    const clubs = [...rows].map(([clubId, r]) => ({ clubId, division: r.division, prevPlacement: r.division === "A" ? Number(r.placement) : null }));
    if (await action.run(() => admin.putClubs(season.id, { clubs }))) await onDone();
  };
  return (
    <Card title="Clubes e colocação anterior" right={<span className={`chip ${ok ? "chip-up" : "chip-down"}`}>{inA} na Série A (precisa de 20)</span>}>
      <div className="scroll-x">
        <table className="tbl">
          <thead><tr><th>Clube</th><th>Divisão</th><th>Colocação anterior (1 a 24)</th></tr></thead>
          <tbody>
            {known.map((c) => {
              const r = rows.get(c.id);
              return (
                <tr key={c.id}>
                  <td>{c.name} <span className="chip">{c.ticker}</span></td>
                  <td>
                    <select aria-label={`Divisão de ${c.name}`} className="input" style={{ height: 32 }} disabled={locked} value={r?.division ?? ""} onChange={(e) => toggle(c.id, e.target.value === "" ? null : (e.target.value as "A" | "B"))}>
                      <option value="">Fora da temporada</option>
                      <option value="A">Série A</option>
                      <option value="B">Série B</option>
                    </select>
                  </td>
                  <td>
                    {r?.division === "A" ? (
                      <input aria-label={`Colocação anterior de ${c.name}`} className="input" style={{ width: 80, height: 32 }} inputMode="numeric" disabled={locked} value={r.placement} onChange={(e) => setRows(new Map(rows).set(c.id, { ...r, placement: e.target.value }))} />
                    ) : <span className="muted small">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="xs muted">1 a 20: a Série A do ano anterior. 21 a 24: os promovidos, na ordem da Série B. O clube do Clube dos Treze que segue na Série B fica sem colocação.</p>
      <ErrorNote message={action.error} />
      <button type="button" className="btn btn-p btn-sm" disabled={locked || !ok || action.busy} onClick={() => void save()}>Confirmar a lista de clubes</button>
    </Card>
  );
}

/** Preparar a temporada (prancha 7c): clubes, oferta, datas do IPO, valores e a tabela de cada copa. */
export function SeasonScreen({ admin }: { admin: AdminApi }) {
  const season = useLoader(() => admin.currentSeason());
  const seasonId = season.data?.season?.id ?? null;
  const rules = useLoader(() => (seasonId ? admin.rules(seasonId) : Promise.resolve(null)));
  const known = useLoader(() => admin.knownClubs());
  const reloadRules = rules.reload;
  useEffect(() => {
    void reloadRules();
  }, [seasonId, reloadRules]);
  const [year, setYear] = useState("");
  const create = useAction();
  const reloadAll = async () => {
    await season.reload();
    await rules.reload();
  };

  if (!season.data) return <LoadState loader={season} />;
  const current = season.data.season;
  if (!current) {
    return (
      <Card title="Nenhuma temporada em andamento">
        <form className="row" onSubmit={(e) => { e.preventDefault(); void create.run(() => admin.createSeason(Number(year))).then(async (ok) => {
          if (ok) await reloadAll();
        }); }}>
          <div className="field"><label htmlFor="ano">Ano da nova temporada</label><input id="ano" className="input" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} /></div>
          <button type="submit" className="btn btn-p" disabled={!/^20\d\d$/.test(year) || create.busy}>Criar a temporada</button>
          <ErrorNote message={create.error} />
        </form>
      </Card>
    );
  }
  const locked = rules.data?.rules.lockedAt != null || opened(current);
  return (
    <div className="stack">
      <div className="row between">
        <span className="chip chip-live">Temporada {current.year} · {current.status === "preparing" ? "em preparação" : "IPO já aberto"}</span>
        {rules.data?.rules.lockedAt && <span className="small muted">Valores travados em {formatInstant(rules.data.rules.lockedAt)}</span>}
      </div>
      <OfferCard season={current} admin={admin} onDone={reloadAll} />
      <PostponeIpo season={current} admin={admin} onDone={reloadAll} />
      {known.data && <ClubsCard key={season.data.clubs.length} season={current} listed={season.data.clubs} known={known.data.clubs} admin={admin} onDone={reloadAll} />}
      <LoadState loader={rules} />
      {rules.data && (
        <LeaguesCard key={JSON.stringify(rules.data.rules)} seasonId={current.id} rules={rules.data.rules} locked={locked} admin={admin} onDone={reloadAll} />
      )}
      {rules.data?.cups.map((cup) => (
        <CupCard key={`${cup.competition}-${cup.confirmedAt}-${cup.phases.map((p) => p.perShare).join(",")}`} seasonId={current.id} cup={cup} locked={locked} admin={admin} onDone={reloadAll} />
      ))}
      <p className="xs muted">Sem as três tabelas confirmadas, as ofertas do IPO não abrem.</p>
    </div>
  );
}
