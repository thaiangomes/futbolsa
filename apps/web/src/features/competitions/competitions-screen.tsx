"use client";

import type { CompetitionMatch, CompetitionStage, CompetitionView, StandingRow } from "@futbolsa/contracts";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../accounts/session-provider";
import { formatKickoff, stageText } from "../club-games";
import { ClubBadgeMark } from "../portfolio/club-badge";
import { type CompetitionsApi, competitionsApi } from "./api";
import { COMPETITION_TABS, currentStageIndex, decidedOnPenalties, isLeague, tabFromSearch } from "./model";

/** A página `/competicoes` (item 11 da fila da partida de teste): uma aba por competição, com a classificação e os jogos. */
export function CompetitionsScreen() {
  const { api } = useSession();
  const competitions = useMemo(() => competitionsApi(api), [api]);
  return <CompetitionsContent api={competitions} />;
}

/** O miolo da tela, sem depender da sessão (os testes passam a API). */
export function CompetitionsContent({ api }: { api: CompetitionsApi }) {
  const [tab, setTab] = useState<CompetitionView["competition"]>("brasileirao-a");
  // a aba escolhida volta da query ao recarregar (a exportação estática não tem rota por competição)
  useEffect(() => {
    setTab(tabFromSearch(window.location.search));
  }, []);
  const pick = (id: CompetitionView["competition"]) => {
    setTab(id);
    window.history.replaceState(null, "", `${window.location.pathname}?c=${id}`);
  };
  return (
    <div className="stack">
      <div className="tabs" role="tablist" aria-label="Competições" style={{ overflowX: "auto" }}>
        {COMPETITION_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => pick(t.id)} style={{ whiteSpace: "nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>
      <CompetitionPanel key={tab} api={api} competition={tab} />
    </div>
  );
}

function useCompetition(api: CompetitionsApi, competition: CompetitionView["competition"]) {
  const [state, setState] = useState<{ data: CompetitionView | null; status: "loading" | "ready" | "error" }>({ data: null, status: "loading" });
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.competition(competition))
      .then(
        (data) => alive && setState({ data, status: "ready" }),
        () => alive && setState({ data: null, status: "error" }),
      );
    return () => {
      alive = false;
    };
  }, [api, competition]);
  return state;
}

function CompetitionPanel({ api, competition }: { api: CompetitionsApi; competition: CompetitionView["competition"] }) {
  const { data, status } = useCompetition(api, competition);
  if (!data) return <p className="muted" role="status">{status === "error" ? "Não foi possível carregar a competição agora." : "Carregando…"}</p>;
  if (data.stages.length === 0 && data.standings.length === 0) {
    return <p className="muted" data-testid="sem-jogos">Esta competição ainda não tem jogos na temporada.</p>;
  }
  return isLeague(competition) ? <League view={data} /> : <Cup view={data} />;
}

/** O clube com selo, e o link para a tela dele quando é listado na temporada. */
function ClubLabel({ club, align = "left", size = 26 }: { club: { ticker: string | null; name: string }; align?: "left" | "right"; size?: number }) {
  const mark = <ClubBadgeMark club={{ ticker: club.ticker ?? "", name: club.name, badgeAbbr: club.ticker ? undefined : club.name.slice(0, 3).toUpperCase() }} size={size} />;
  const name = club.ticker ? (
    <a href={`/clube?t=${encodeURIComponent(club.ticker)}`} style={{ color: "inherit", textDecoration: "none" }} className="b">{club.name}</a>
  ) : (
    <span className="b">{club.name}</span>
  );
  return (
    <span className="cb" style={{ flexDirection: align === "right" ? "row-reverse" : "row", minWidth: 0 }}>
      {mark}
      {name}
    </span>
  );
}

function League({ view }: { view: CompetitionView }) {
  const [index, setIndex] = useState(() => currentStageIndex(view.stages));
  const stage = view.stages[index];
  return (
    <div className="stack">
      {view.standings.length > 0 && <Standings rows={view.standings} />}
      {stage && (
        <section className="card" aria-labelledby="t-rodada" data-testid="rodada">
          <div className="card-h row between" style={{ gap: 8 }}>
            <h2 className="card-t" id="t-rodada">{stageText(stage) ?? "Jogos"}</h2>
            <span className="row-s">
              <button type="button" className="btn btn-sm" aria-label="Rodada anterior" disabled={index <= 0} onClick={() => setIndex(index - 1)}>‹</button>
              <button type="button" className="btn btn-sm" aria-label="Próxima rodada" disabled={index >= view.stages.length - 1} onClick={() => setIndex(index + 1)}>›</button>
            </span>
          </div>
          <div className="card-b"><Matches matches={stage.matches} /></div>
        </section>
      )}
    </div>
  );
}

function Standings({ rows }: { rows: readonly StandingRow[] }) {
  return (
    <section className="card" aria-labelledby="t-class" data-testid="classificacao">
      <div className="card-h"><h2 className="card-t" id="t-class">Classificação</h2></div>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th><th>Clube</th><th className="r">Pts</th><th className="r">J</th><th className="r">V</th><th className="r">E</th><th className="r">D</th><th className="r">SG</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.club.name} data-testid="linha-classificacao">
                <td className="num">{r.position}</td>
                <td><ClubLabel club={r.club} /></td>
                <td className="r num b">{r.points}</td>
                <td className="r num">{r.played}</td>
                <td className="r num">{r.wins}</td>
                <td className="r num">{r.draws}</td>
                <td className="r num">{r.losses}</td>
                <td className="r num">{r.goalDiff > 0 ? `+${r.goalDiff}` : r.goalDiff}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * A copa, uma fase por vez (a Copa do Brasil tem nove): abre na fase atual (a primeira com jogo por acontecer) e as fases ficam
 * numa fileira para escolher; a atual leva um ponto, mesmo depois de o jogador olhar outra.
 */
function Cup({ view }: { view: CompetitionView }) {
  const atual = currentStageIndex(view.stages);
  const [index, setIndex] = useState(atual);
  const stage: CompetitionStage | undefined = view.stages[index];
  return (
    <div className="stack">
      <div className="row-s" role="group" aria-label="Fases" style={{ overflowX: "auto", flexWrap: "nowrap", gap: 8, paddingBottom: 4 }} data-testid="fases">
        {view.stages.map((st, i) => (
          <button
            key={st.phase ?? i}
            type="button"
            className={i === index ? "btn btn-p btn-sm" : "btn btn-ghost btn-sm"}
            aria-pressed={i === index}
            data-atual={i === atual ? "true" : undefined}
            style={{ whiteSpace: "nowrap", flex: "none" }}
            onClick={() => setIndex(i)}
          >
            {i === atual && <span className="dot-live" aria-hidden="true" style={{ marginRight: 6 }} />}
            {stageText(st) ?? "Jogos"}
          </button>
        ))}
      </div>
      {stage && (
        <section className="card" aria-labelledby="t-fase" data-testid="fase">
          <div className="card-h row between" style={{ gap: 8 }}>
            <h2 className="card-t" id="t-fase">{stageText(stage) ?? "Jogos"}{index === atual ? " · fase atual" : ""}</h2>
            <span className="row-s">
              <button type="button" className="btn btn-sm" aria-label="Fase anterior" disabled={index <= 0} onClick={() => setIndex(index - 1)}>‹</button>
              <button type="button" className="btn btn-sm" aria-label="Próxima fase" disabled={index >= view.stages.length - 1} onClick={() => setIndex(index + 1)}>›</button>
            </span>
          </div>
          <div className="card-b"><Matches matches={stage.matches} /></div>
        </section>
      )}
    </div>
  );
}

/** Os jogos de uma rodada ou fase: mandante, placar (ou data e hora de Brasília) e visitante; quem passou fica destacado. */
function Matches({ matches }: { matches: readonly CompetitionMatch[] }) {
  return (
    <ul className="stack-s" style={{ listStyle: "none", margin: 0, padding: 0, gap: 12 }}>
      {matches.map((m, i) => (
        <li key={`${m.kickoff}|${m.home.name}|${i}`} data-testid="confronto" style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, alignItems: "center" }}>
          <span style={{ minWidth: 0 }} className={m.advanced === "away" ? "muted" : undefined}><ClubLabel club={m.home} size={24} /></span>
          <span className="r" style={{ textAlign: "center", minWidth: 74 }}>
            <Score m={m} />
          </span>
          <span style={{ minWidth: 0, display: "flex", justifyContent: "flex-end" }} className={m.advanced === "home" ? "muted" : undefined}><ClubLabel club={m.away} align="right" size={24} /></span>
        </li>
      ))}
    </ul>
  );
}

function Score({ m }: { m: CompetitionMatch }) {
  if (m.status === "finished" && m.homeGoals !== null && m.awayGoals !== null) {
    return (
      <>
        <span className="num b" data-testid="placar">{m.homeGoals} × {m.awayGoals}</span>
        {m.advanced && (
          <span className="xs muted" style={{ display: "block" }} data-testid="passou">
            {m.advanced === "home" ? "Passou o mandante" : "Passou o visitante"}{decidedOnPenalties(m) ? " nos pênaltis" : ""}
          </span>
        )}
      </>
    );
  }
  if (m.inPlay) return <span className="chip chip-live" data-testid="em-jogo"><span className="dot-live" />Em jogo</span>;
  if (m.status === "postponed") return <span className="xs muted" data-testid="adiado">Adiado</span>;
  if (m.status === "cancelled") return <span className="xs muted" data-testid="cancelado">Cancelado</span>;
  return <span className="num small" data-testid="quando">{formatKickoff(m.kickoff)}</span>;
}
