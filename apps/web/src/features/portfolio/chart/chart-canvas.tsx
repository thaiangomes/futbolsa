"use client";

import type { ChartCandle } from "@futbolsa/contracts";
import { useEffect, useRef, useState } from "react";
import { formatChartClock, formatChartDateTime, formatChartDay } from "../format";
import type { ChartMarker, MarkerTone } from "./markers";
import { candleData, lineData, volumeData } from "./series";

type Lib = typeof import("lightweight-charts");
type Handle = {
  chart: import("lightweight-charts").IChartApi;
  price: import("lightweight-charts").ISeriesApi<"Line" | "Candlestick">;
  volume: import("lightweight-charts").ISeriesApi<"Histogram"> | null;
  markers: import("lightweight-charts").ISeriesMarkersPluginApi<import("lightweight-charts").Time>;
  lib: Lib;
  colors: ChartColors;
  lines: import("lightweight-charts").IPriceLine[];
};

/** As cores do tema (escuro ou claro), lidas das variáveis de CSS no navegador. */
export interface ChartColors {
  text: string;
  grid: string;
  amber: string;
  up: string;
  down: string;
  neutral: string;
  dividend: string;
}

export function readChartColors(el: HTMLElement): ChartColors {
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    text: pick("--muted", "#98A4B7"),
    grid: pick("--line", "#253042"),
    amber: pick("--amber", "#FFB020"),
    up: pick("--up", "#2BD46F"),
    down: pick("--down", "#FF5C5C"),
    neutral: pick("--muted", "#98A4B7"),
    dividend: pick("--div", "#4FB3FF"),
  };
}

const toneColor = (colors: ChartColors, tone: MarkerTone): string =>
  tone === "up" ? colors.up : tone === "down" ? colors.down : tone === "dividend" ? colors.dividend : tone === "amber" ? colors.amber : colors.neutral;

export interface ChartCanvasProps {
  candles: readonly ChartCandle[];
  interval: "15m" | "1d";
  mode: "line" | "candles";
  markers: readonly ChartMarker[];
  /** O preço do IPO (linha de referência) e o meu preço médio (só com ações), em centavos. */
  ipoPrice: number | null;
  averagePrice: number | null;
  onSelect: (id: string | null) => void;
  /** Altura menor (celular, ou quando o gráfico divide a tela). */
  short?: boolean;
}

/**
 * O desenho do gráfico do clube na biblioteca Lightweight Charts: linha ou candles, volume numa escala própria na base,
 * marcadores (jogos, dividendos, meus negócios) e linhas de referência (IPO e preço médio). A biblioteca só é importada no
 * navegador, dentro de um efeito, para a exportação estática do Next não tocar em `window`. O eixo e o cursor mostram o
 * horário de Brasília, porque a biblioteca desenha em UTC por padrão.
 */
export function ChartCanvas({ candles, interval, mode, markers, ipoPrice, averagePrice, onSelect, short }: ChartCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const [handle, setHandle] = useState<Handle | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // o gráfico nasce (e é refeito) só quando o modo ou o intervalo mudam
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let disposed = false;
    let current: Handle | null = null;
    void import("lightweight-charts").then((lib) => {
      if (disposed || !container.current) return;
      const colors = readChartColors(el);
      const chart = lib.createChart(el, {
        autoSize: true,
        layout: { background: { type: lib.ColorType.Solid, color: "transparent" }, textColor: colors.text, fontFamily: "Inter, system-ui, sans-serif" },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: colors.grid },
        timeScale: {
          borderColor: colors.grid,
          timeVisible: interval === "15m",
          secondsVisible: false,
          tickMarkFormatter: (time: unknown) => (interval === "15m" ? formatChartClock(time as number) : formatChartDay(time as number)),
        },
        localization: { timeFormatter: (time: unknown) => formatChartDateTime(time as number), priceFormatter: (p: number) => p.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
      });
      const price =
        mode === "line"
          ? chart.addSeries(lib.LineSeries, { color: colors.amber, lineWidth: 2, priceLineVisible: true })
          : chart.addSeries(lib.CandlestickSeries, { upColor: colors.up, downColor: colors.down, borderUpColor: colors.up, borderDownColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down });
      const volume = chart.addSeries(lib.HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "" });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      const markersApi = lib.createSeriesMarkers(price, []);
      chart.subscribeClick((param) => {
        const id = (param as { hoveredObjectId?: unknown }).hoveredObjectId;
        onSelectRef.current(typeof id === "string" ? id : null);
      });
      current = { chart, price: price as Handle["price"], volume, markers: markersApi, lib, colors, lines: [] };
      setHandle(current);
    });
    return () => {
      disposed = true;
      setHandle(null);
      current?.chart.remove();
    };
  }, [mode, interval]);

  // os dados e as linhas de referência andam a cada mudança, sem refazer o gráfico
  useEffect(() => {
    if (!handle) return;
    const { price, volume, markers: markersApi, colors, lib } = handle;
    const fadeUp = `${colors.up}66`;
    const fadeDown = `${colors.down}66`;
    if (mode === "line") (price as import("lightweight-charts").ISeriesApi<"Line">).setData(lineData(candles) as never);
    else (price as import("lightweight-charts").ISeriesApi<"Candlestick">).setData(candleData(candles) as never);
    volume?.setData(volumeData(candles, { up: fadeUp, down: fadeDown }) as never);
    markersApi.setMarkers(
      markers.map((m) => ({ id: m.id, time: m.time as never, position: m.position, shape: m.shape, color: toneColor(colors, m.tone), text: m.text })),
    );
    for (const line of handle.lines) price.removePriceLine(line);
    handle.lines = [];
    if (ipoPrice !== null) handle.lines.push(price.createPriceLine({ price: ipoPrice / 100, color: colors.neutral, lineStyle: lib.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "IPO" }));
    if (averagePrice !== null) handle.lines.push(price.createPriceLine({ price: averagePrice / 100, color: colors.dividend, lineStyle: lib.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "Preço médio" }));
    handle.chart.timeScale().fitContent();
  }, [handle, candles, markers, mode, ipoPrice, averagePrice]);

  return <div ref={container} className={short ? "chart-box short" : "chart-box"} data-testid="grafico" role="img" aria-label="Gráfico de preço do clube; a lista de marcadores está logo abaixo" />;
}
