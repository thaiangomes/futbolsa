/**
 * Um `lightweight-charts` falso para os testes de tela: guarda o que a tela desenhou (séries, dados, marcadores, linhas) e
 * deixa o teste "clicar" no gráfico. O jsdom não tem canvas, e o que importa é o que a tela manda desenhar.
 * Uso: `vi.mock("lightweight-charts", async () => (await import("../../../test-support/fake-charts")).fakeCharts)`.
 */
export class FakeSeries {
  data: unknown[] = [];
  markers: { id?: string; time: number; position: string; shape: string; color: string; text: string }[] = [];
  lines: { price: number; title?: string }[] = [];
  constructor(
    readonly kind: string,
    readonly options: Record<string, unknown>,
  ) {}
  setData(data: unknown[]): void {
    this.data = data;
  }
  priceScale() {
    return { applyOptions: () => undefined };
  }
  createPriceLine(line: { price: number; title?: string }) {
    this.lines.push(line);
    return line;
  }
  removePriceLine(line: { price: number }): void {
    this.lines = this.lines.filter((l) => l !== line);
  }
}

export class FakeChart {
  series: FakeSeries[] = [];
  removed = false;
  click: ((param: { hoveredObjectId?: unknown }) => void) | null = null;
  constructor(
    readonly el: HTMLElement,
    readonly options: Record<string, unknown>,
  ) {}
  addSeries(definition: { kind: string }, options: Record<string, unknown> = {}): FakeSeries {
    const series = new FakeSeries(definition.kind, options);
    this.series.push(series);
    return series;
  }
  timeScale() {
    return { fitContent: () => undefined };
  }
  subscribeClick(callback: (param: { hoveredObjectId?: unknown }) => void): void {
    this.click = callback;
  }
  remove(): void {
    this.removed = true;
  }
  /** A série de preço (linha ou candles) e a de volume. */
  price(): FakeSeries | undefined {
    return this.series.find((s) => s.kind === "Line" || s.kind === "Candlestick");
  }
  volume(): FakeSeries | undefined {
    return this.series.find((s) => s.kind === "Histogram");
  }
}

export const created: FakeChart[] = [];

export const fakeCharts = {
  LineSeries: { kind: "Line" },
  CandlestickSeries: { kind: "Candlestick" },
  HistogramSeries: { kind: "Histogram" },
  ColorType: { Solid: "solid" },
  LineStyle: { Dashed: 2 },
  createChart(el: HTMLElement, options: Record<string, unknown>): FakeChart {
    const chart = new FakeChart(el, options);
    created.push(chart);
    return chart;
  },
  createSeriesMarkers(series: FakeSeries, markers: FakeSeries["markers"]) {
    series.markers = markers;
    return {
      setMarkers(next: FakeSeries["markers"]) {
        series.markers = next;
      },
    };
  },
};

/** Os gráficos ainda vivos (o último é o que a tela usa agora). */
export const live = () => created.filter((c) => !c.removed);
