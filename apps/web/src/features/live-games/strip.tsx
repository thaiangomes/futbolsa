"use client";

import type { LiveGame, LiveGameSide } from "@futbolsa/contracts";
import { useState } from "react";
import { changeTone, clubHref, formatDayChange, liveCountText, minuteText, scoreText, showStrip, siglaOf } from "./model";
import { useLiveGames } from "./provider";

/** Como o leitor de tela fala o time da faixa: nome, ticker, quanto sobe ou cai hoje e para onde o toque leva. */
function sideLabel(side: LiveGameSide): string {
  const move = side.changeBp === null ? "" : side.changeBp > 0 ? ", sobe " : side.changeBp < 0 ? ", cai " : ", estável, ";
  const pct = side.changeBp === null ? "" : `${(Math.abs(side.changeBp) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}% hoje`;
  return `${side.name}${side.ticker ? `, ${side.ticker}` : ""}${move}${pct}${side.ticker ? ". Abre o mercado do clube" : ""}`;
}

/** A sigla com a variação do dia ao lado; vira link para o Mercado do clube quando ele é listado. `first` põe a variação antes da sigla (time da casa). */
function Side({ side, first }: { side: LiveGameSide; first: boolean }) {
  const change = (
    <span className={changeTone(side.changeBp)} style={{ fontSize: 11.5, fontWeight: 600 }} data-testid="faixa-variacao">{formatDayChange(side.changeBp)}</span>
  );
  const sigla = <span style={{ fontWeight: 700 }}>{siglaOf(side)}</span>;
  const href = clubHref(side);
  const style = { display: "inline-flex", alignItems: "baseline", gap: 5, textDecoration: "none", color: "var(--text)", padding: "12px 0" } as const;
  const inner = first ? <>{change}{sigla}</> : <>{sigla}{change}</>;
  return href ? (
    <a href={href} aria-label={sideLabel(side)} style={style}>{inner}</a>
  ) : (
    <span style={style}>{inner}</span>
  );
}

function Game({ game }: { game: LiveGame }) {
  return (
    <span className="num" style={{ display: "inline-flex", alignItems: "center", gap: 8 }} data-testid="faixa-jogo">
      <Side side={game.home} first />
      <span style={{ fontWeight: 700, fontSize: 14, padding: "1px 7px", borderRadius: 6, background: "var(--panel2)" }} data-testid="faixa-placar">{scoreText(game)}</span>
      <Side side={game.away} first={false} />
      <span style={{ color: "var(--amber-ink)", fontWeight: 600, fontSize: 12 }}>{minuteText(game)}</span>
    </span>
  );
}

const chevron = (d: string) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

/**
 * A faixa dos jogos ao vivo no topo de todas as telas (Protótipos, "Jogos ao vivo"; item 25 da fila da partida de teste).
 * Só aparece com jogo em andamento. No computador, uma linha que rola de lado com todos os jogos e o link "Todos os jogos ›";
 * no celular, um jogo por vez com o botão `2/5 ›`, e ela recolhe numa linha fina. Fica no fluxo da página (nunca por cima do
 * conteúdo), então a boleta aberta, que é fixa e tem o escurecido por cima, cobre a faixa em vez de ficar atrás dela.
 */
export function LiveStrip() {
  const { data } = useLiveGames();
  return <LiveStripView games={showStrip(data) ? data!.live : []} />;
}

/** A faixa sem depender do contexto (os testes passam os jogos). Sem jogo, não desenha nada. */
export function LiveStripView({ games }: { games: readonly LiveGame[] }) {
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  if (games.length === 0) return null;
  const i = index % games.length;
  const current = games[i]!;
  const counter = `${i + 1}/${games.length}`;
  return (
    <div className="fbc" data-testid="faixa-ao-vivo" style={{ width: "100%", color: "var(--text)" }}>
      <div className="live-pc" role="region" aria-label="Jogos ao vivo" style={{ alignItems: "center", gap: 14, height: 36, padding: "0 24px", background: "var(--bg2)", borderBottom: "1px solid var(--line)", fontSize: 13, whiteSpace: "nowrap" }}>
        <span className="row-s" style={{ flex: "none", color: "var(--amber-ink)", fontWeight: 700, fontSize: 11.5, letterSpacing: ".08em", textTransform: "uppercase" }}><span className="dot-live" />Ao vivo</span>
        <div style={{ display: "flex", alignItems: "center", overflowX: "auto", scrollbarWidth: "none", flex: 1, minWidth: 0 }}>
          {games.map((g) => (
            <div key={`${g.kickoff}|${g.home.name}`} style={{ padding: "0 16px", borderLeft: "1px solid var(--line)", flex: "none" }}><Game game={g} /></div>
          ))}
        </div>
        <a href="/jogos-ao-vivo" style={{ flex: "none", color: "var(--amber-ink)", fontWeight: 600, fontSize: 12.5, textDecoration: "none" }}>Todos os jogos ›</a>
      </div>

      {!collapsed && (
        <div className="live-cel" role="region" aria-label="Jogos ao vivo" style={{ alignItems: "center", gap: 6, height: 44, padding: "0 4px 0 12px", background: "var(--bg2)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
          <span className="dot-live" title="Ao vivo" />
          <div aria-live="polite" style={{ flex: 1, minWidth: 0, display: "flex", justifyContent: "center", fontSize: 13, overflow: "hidden" }}><Game game={current} /></div>
          <button type="button" onClick={() => setIndex(i + 1)} aria-label={`Próximo jogo (${counter})`} style={{ flex: "none", height: 44, minWidth: 52, border: 0, background: "transparent", color: "var(--muted)", font: "600 12px Inter, sans-serif", cursor: "pointer" }}>{counter} ›</button>
          <button type="button" onClick={() => setCollapsed(true)} aria-label="Recolher a faixa dos jogos" style={{ flex: "none", width: 40, height: 44, border: 0, background: "transparent", color: "var(--muted)", cursor: "pointer", alignItems: "center", justifyContent: "center", display: "inline-flex" }}>{chevron("M6 15l6-6 6 6")}</button>
        </div>
      )}
      {collapsed && (
        <button type="button" className="live-cel" onClick={() => setCollapsed(false)} aria-label="Mostrar a faixa dos jogos ao vivo" style={{ alignItems: "center", justifyContent: "space-between", gap: 8, width: "100%", height: 28, padding: "0 12px", border: 0, borderBottom: "1px solid var(--line)", background: "var(--bg2)", color: "var(--muted)", font: "600 12px Inter, sans-serif", cursor: "pointer" }}>
          <span className="row-s"><span className="dot-live" /><span style={{ color: "var(--text)" }}>{liveCountText(games.length)}</span></span>
          <span className="row-s">mostrar {chevron("M6 9l6 6 6-6")}</span>
        </button>
      )}
    </div>
  );
}
