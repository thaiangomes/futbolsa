"use client";

import { CHART_RANGES, type ChartRange } from "@futbolsa/contracts";
import { useMemo, useState } from "react";
import type { PortfolioApi } from "../api";
import { formatMoney } from "../format";
import { formatHour } from "../../market/format";
import { useIsNarrow } from "../../market/mobile-club";
import { ChartCanvas } from "./chart-canvas";
import { RANGE_LABELS } from "./labels";
import { MarkerBalloon } from "./marker-balloon";
import { MarkerMenu } from "./marker-menu";
import { filterMarkers, useMarkerPrefs } from "./marker-prefs";
import { buildMarkers, type ChartMarker } from "./markers";
import { toSeconds } from "./series";
import { useClubChart } from "./use-club-chart";

/**
 * O gráfico do clube (prancha 1): linha que alterna para candles, volume, marcadores de jogos, dividendos e dos meus
 * negócios (com balão ao clicar), linhas do IPO e do meu preço médio, abas Hoje, 7 dias, 30 dias e Temporada. Os mesmos
 * marcadores saem também numa lista de texto, para leitor de tela e celular. Entra na página do clube da F9.
 */
export function ClubChart({ ticker, api, logged, short = false }: { ticker: string; api: PortfolioApi; logged: boolean; short?: boolean }) {
  const [range, setRange] = useState<ChartRange>("today");
  const [mode, setMode] = useState<"line" | "candles">("line");
  const [selected, setSelected] = useState<string | null>(null);
  const data = useClubChart(api, ticker, range, logged);
  const narrow = useIsNarrow();

  const [prefs] = useMarkerPrefs();
  const allMarkers: ChartMarker[] = useMemo(() => {
    if (!data.candles || data.candles.candles.length === 0) return [];
    const list = data.candles.candles;
    return buildMarkers({
      ticker,
      interval: data.candles.interval,
      window: { from: toSeconds(list[0]!.start), to: toSeconds(list[list.length - 1]!.start) },
      games: data.markers?.games ?? [],
      payouts: data.markers?.payouts ?? [],
      trades: data.mine?.trades ?? [],
    });
  }, [data.candles, data.markers, data.mine, ticker]);
  // o que o jogador desligou no botão Marcadores (critérios 46 e 47) sai do gráfico e da lista
  const markers = useMemo(() => filterMarkers(allMarkers, prefs), [allMarkers, prefs]);
  // as competições com jogo no período, na ordem em que aparecem
  const competitions = useMemo(() => [...new Set(allMarkers.flatMap((m) => (m.kind === "game" && m.competition ? [m.competition] : [])))], [allMarkers]);

  const picked = markers.find((m) => m.id === selected) ?? null;
  const resp = data.candles;
  const last = resp?.candles[resp.candles.length - 1];

  return (
    <section className="card" aria-labelledby="t-grafico" data-testid="grafico-clube">
      <div className="card-h">
        <h2 className="card-t" id="t-grafico">Gráfico de {ticker}</h2>
        <div className="row-s">
          <div className="seg" role="group" aria-label="Período">
            {CHART_RANGES.map((r) => (
              <button key={r} type="button" aria-pressed={range === r} onClick={() => { setRange(r); setSelected(null); }}>{RANGE_LABELS[r]}</button>
            ))}
          </div>
          <MarkerMenu competitions={competitions} showTrades={logged} />
          <div className="seg" role="group" aria-label="Tipo de gráfico">
            <button type="button" aria-pressed={mode === "line"} onClick={() => setMode("line")}>Linha</button>
            <button type="button" aria-pressed={mode === "candles"} onClick={() => setMode("candles")}>Candles</button>
          </div>
        </div>
      </div>
      <div className="card-b stack-s" style={{ position: "relative" }}>
        {data.status === "error" && (
          <div className="note note-err" role="alert" data-testid="grafico-erro">
            <div>Não foi possível carregar o gráfico. <button type="button" className="link-btn" onClick={() => void data.reload()}>Tentar de novo</button></div>
          </div>
        )}
        {data.status === "loading" && <p className="muted" data-testid="grafico-carregando">Carregando…</p>}
        {data.status === "ready" && resp && resp.candles.length === 0 && (
          <p className="muted" data-testid="grafico-vazio">
            {resp.tradingOpensAt ? `Negociação abre às ${formatHour(resp.tradingOpensAt)}.` : "Ainda não há negócios neste período."}
          </p>
        )}
        {resp && resp.candles.length > 0 && (
          <>
            <div className="legend" data-testid="legenda-grafico">
              {last && <span>Último: <b className="num" style={{ color: "var(--text)" }}>{formatMoney(last.close)}</b></span>}
              {last && <span>Abertura {formatMoney(last.open)} · Máx. {formatMoney(last.high)} · Mín. {formatMoney(last.low)}</span>}
              {resp.ipoPrice !== null && <span>IPO: {formatMoney(resp.ipoPrice)}</span>}
              {data.mine?.averagePrice != null && <span>Meu preço médio: {formatMoney(data.mine.averagePrice)}</span>}
            </div>
            <ChartCanvas
              candles={resp.candles}
              interval={resp.interval}
              mode={mode}
              markers={markers}
              ipoPrice={resp.ipoPrice}
              averagePrice={data.mine?.averagePrice ?? null}
              onSelect={setSelected}
              short={short || narrow}
            />
            {picked && <MarkerBalloon marker={picked} onClose={() => setSelected(null)} />}
          </>
        )}
        {markers.length > 0 && (
          <details data-testid="lista-marcadores">
            <summary className="small b">Lista de marcadores ({markers.length})</summary>
            <ul className="sr-list" style={{ marginTop: 8 }}>
              {[...markers].reverse().map((m) => (
                <li key={m.id}>
                  <button type="button" className="link-btn" onClick={() => setSelected(m.id)}>{m.title}</button>
                  <span className="muted"> · {m.lines.join(" · ")}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
