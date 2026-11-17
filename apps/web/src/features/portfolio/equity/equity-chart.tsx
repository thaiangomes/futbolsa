"use client";

import type { EquityResponse } from "@futbolsa/contracts";
import { useEffect, useMemo, useRef } from "react";
import { readChartColors } from "../chart/chart-canvas";
import { MarkerMenu } from "../chart/marker-menu";
import { useMarkerPrefs } from "../chart/marker-prefs";
import { formatChartDateTime, formatChartDay, formatMoney } from "../format";
import { equitySeries } from "./equity-series";

/**
 * O gráfico de patrimônio: a linha do patrimônio a cada 24h de Brasília, a linha de R$ 100.000,00 (o ponto de partida) e um
 * marcador nos dias em que houve dividendo, com o total do dia. A biblioteca só carrega no navegador (efeito).
 */
export function EquityChart({ data, short = false }: { data: EquityResponse; short?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const series = useMemo(() => equitySeries(data), [data]);
  // o botão Marcadores é o mesmo do gráfico do clube: aqui só há dividendos (critério 47)
  const [prefs] = useMarkerPrefs();
  const shown = prefs.payout ? series.markers : [];

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let disposed = false;
    let remove: (() => void) | null = null;
    void import("lightweight-charts").then((lib) => {
      if (disposed) return;
      const colors = readChartColors(el);
      const chart = lib.createChart(el, {
        autoSize: true,
        layout: { background: { type: lib.ColorType.Solid, color: "transparent" }, textColor: colors.text, fontFamily: "Inter, system-ui, sans-serif" },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: colors.grid },
        timeScale: { borderColor: colors.grid, tickMarkFormatter: (time: unknown) => formatChartDay(time as number) },
        localization: { timeFormatter: (time: unknown) => formatChartDateTime(time as number), priceFormatter: (p: number) => p.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
      });
      const line = chart.addSeries(lib.LineSeries, { color: colors.dividend, lineWidth: 2 });
      line.setData(series.points as never);
      line.createPriceLine({ price: series.base, color: colors.neutral, lineStyle: lib.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "R$ 100.000" });
      lib.createSeriesMarkers(
        line,
        shown.map((m) => ({ time: m.time as never, position: "belowBar" as const, shape: "square" as const, color: colors.amber, text: m.text })),
      );
      chart.timeScale().fitContent();
      remove = () => chart.remove();
    });
    return () => {
      disposed = true;
      remove?.();
    };
  }, [series, shown]);

  return (
    <div>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 6 }}>
        <MarkerMenu only="payout" />
      </div>
      <div ref={container} className={short ? "chart-box short" : "chart-box"} data-testid="grafico-patrimonio" role="img" aria-label={`Gráfico do patrimônio; valor atual ${formatMoney(data.current.equity)}`} />
      {shown.length > 0 && (
        <ul className="sr-list" data-testid="dias-com-dividendo" style={{ marginTop: 8 }}>
          {shown.map((m) => (
            <li key={m.time} className="xs muted">{formatChartDay(m.time)}: dividendos de {m.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
