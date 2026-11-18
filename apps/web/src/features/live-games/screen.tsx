"use client";

import type { LiveGame, LiveGameSide, LiveGames } from "@futbolsa/contracts";
import { formatCents } from "../../lib/format";
import { competitionName, formatKickoff, stageText } from "../club-games";
import { formatHour } from "../market/format";
import { ClubBadgeMark } from "../portfolio/club-badge";
import { changeTone, clubHref, formatDayChange, phaseText, siglaOf } from "./model";
import { useLiveGames } from "./provider";

const markOf = (side: LiveGameSide, size: number) => (
  <ClubBadgeMark club={{ ticker: side.ticker ?? "", name: side.name, badgeAbbr: side.ticker ? undefined : side.name.slice(0, 3).toUpperCase() }} size={size} />
);

const stageLine = (g: LiveGame) => [competitionName(g.competition), stageText(g)].filter(Boolean).join(" · ");
const keyOf = (g: LiveGame) => `${g.kickoff}|${g.home.name}`;

/** Um time do cartão: selo, nome, ticker, preço, variação do dia e o gol; tocar abre o Mercado do clube. */
function TeamRow({ side, goals }: { side: LiveGameSide; goals: number | null }) {
  const href = clubHref(side);
  const body = (
    <>
      <span className="row" style={{ gap: 12, flexWrap: "nowrap", minWidth: 0 }}>
        {markOf(side, 40)}
        <span className="stack-s" style={{ gap: 1, minWidth: 0 }}>
          <span className="b" style={{ fontSize: 15 }} data-testid="time-nome">{side.name}</span>
          {side.ticker && side.price !== null && (
            <span className="small num">
              <span className="muted">{side.ticker}</span> <span className="b">{formatCents(side.price)}</span>{" "}
              <span className={`${changeTone(side.changeBp)} b`} data-testid="time-variacao">{formatDayChange(side.changeBp)}</span>
            </span>
          )}
        </span>
      </span>
      <span className="disp num" style={{ fontSize: 38, fontWeight: 700, lineHeight: 1 }} data-testid="time-gols">{goals ?? "–"}</span>
    </>
  );
  const style = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 0", textDecoration: "none", color: "var(--text)" } as const;
  return href ? <a href={href} style={style} aria-label={`${side.name}. Abre o mercado do clube`}>{body}</a> : <div style={style}>{body}</div>;
}

function GameCard({ game }: { game: LiveGame }) {
  return (
    <section className="card" data-testid="jogo-ao-vivo" aria-label={`${game.home.name} contra ${game.away.name}`}>
      <div className="card-h">
        <h2 className="card-t">{stageLine(game)}</h2>
        <span className="chip chip-live"><span className="dot-live" />{phaseText(game)}</span>
      </div>
      <div className="card-b stack-s" style={{ gap: 2 }}>
        <TeamRow side={game.home} goals={game.score?.home ?? null} />
        <TeamRow side={game.away} goals={game.score?.away ?? null} />
        <span className="xs muted" style={{ paddingTop: 8 }}>Começou às {formatHour(game.kickoff)} · variação do dia desde as 0h</span>
      </div>
    </section>
  );
}

const pair = (g: LiveGame) => `${siglaOf(g.home)} × ${siglaOf(g.away)}`;
const variations = (g: LiveGame) => [g.home, g.away].map((s) => `${siglaOf(s)} ${formatDayChange(s.changeBp)}`.trim()).join(" · ");
const listRow = { display: "grid", gridTemplateColumns: "56px minmax(0,1fr) auto", gap: 10, alignItems: "center", padding: "9px 0", fontSize: 13 } as const;

function Aside({ data }: { data: LiveGames }) {
  return (
    <aside className="stack">
      <section className="card" aria-labelledby="t-depois">
        <div className="card-h"><h2 className="card-t" id="t-depois">Mais tarde hoje</h2></div>
        <div className="card-b" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {data.upcoming.length === 0 ? (
            <p className="muted small" data-testid="sem-mais-tarde">Nenhum outro jogo hoje.</p>
          ) : (
            data.upcoming.map((g) => (
              <div key={keyOf(g)} data-testid="mais-tarde" style={listRow}>
                <span className="b num">{formatHour(g.kickoff)}</span>
                <span className="b">{pair(g)}</span>
                <span className="xs num">{variations(g)}</span>
              </div>
            ))
          )}
        </div>
      </section>
      <section className="card" aria-labelledby="t-fim">
        <div className="card-h"><h2 className="card-t" id="t-fim">Encerrados hoje</h2></div>
        <div className="card-b" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {data.finished.length === 0 ? (
            <p className="muted small" data-testid="sem-encerrados">Nenhum jogo encerrado hoje.</p>
          ) : (
            data.finished.map((g) => (
              <div key={keyOf(g)} data-testid="encerrado" style={listRow}>
                <span className="muted num">{formatHour(g.kickoff)}</span>
                <span className="b num">{siglaOf(g.home)} {g.score?.home} × {g.score?.away} {siglaOf(g.away)}</span>
                <span className="chip" style={{ height: 22 }}>Fim</span>
              </div>
            ))
          )}
        </div>
      </section>
      <section className="card" aria-labelledby="t-como">
        <div className="card-h"><h2 className="card-t" id="t-como">Como ler o placar</h2></div>
        <ul className="card-b small muted stack-s m0" style={{ paddingLeft: 34, gap: 8 }}>
          <li data-testid="aviso-atraso">O placar pode estar até 5 minutos atrasado; gol não paga dividendo, só o resultado final.</li>
          <li>O mercado segue aberto durante o jogo e o preço pode mudar de repente. Toque num time para abrir o mercado dele.</li>
        </ul>
      </section>
    </aside>
  );
}

/**
 * A página dos jogos ao vivo (`/jogos-ao-vivo`, item 25 da fila da partida de teste): um cartão por jogo em andamento e, ao
 * lado, os de mais tarde, os encerrados do dia e o aviso do atraso. Sem jogo em andamento, mostra o próximo jogo.
 */
export function LiveGamesScreen() {
  const { data, error } = useLiveGames();
  return <LiveGamesContent data={data} error={error} />;
}

/** O miolo da página, sem depender do contexto (os testes passam os dados). */
export function LiveGamesContent({ data, error = false }: { data: LiveGames | null; error?: boolean }) {
  if (!data) return <p className="muted" role="status">{error ? "Não foi possível carregar os jogos agora." : "Carregando…"}</p>;
  const live = data.live.length > 0;
  return (
    <div className="g-main-aside">
      <div className="stack">
        {live ? (
          <>
            <div>
              <span className="chip chip-live" data-testid="contagem"><span className="dot-live" />{data.live.length} {data.live.length === 1 ? "jogo em andamento" : "jogos em andamento"}</span>
            </div>
            <div className="g-2">{data.live.map((g) => <GameCard key={keyOf(g)} game={g} />)}</div>
          </>
        ) : (
          <section className="card card-b stack-s" style={{ gap: 10, padding: 28 }} data-testid="sem-jogo-ao-vivo">
            <span className="h2">Nenhum jogo em andamento agora</span>
            <span className="small muted">A faixa do topo some enquanto não há jogo e volta sozinha quando o próximo começar.</span>
            {data.next && (
              <div className="kv" style={{ maxWidth: 520 }} data-testid="proximo-jogo">
                <span>Próximo jogo</span>
                <span>{formatKickoff(data.next.kickoff)} · {stageLine(data.next)} · {pair(data.next)}</span>
              </div>
            )}
          </section>
        )}
      </div>
      <Aside data={data} />
    </div>
  );
}
