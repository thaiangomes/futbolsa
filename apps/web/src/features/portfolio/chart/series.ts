import type { CandleEvent, ChartCandle } from "@futbolsa/contracts";

/** O tempo das séries é o instante real em segundos (UTC); o eixo e o cursor mostram Brasília por um formatador. */
export function toSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** Centavos como reais (a escala do gráfico). Só para desenhar: nenhuma conta de dinheiro acontece aqui. */
const reais = (cents: number) => cents / 100;

export interface LinePoint {
  time: number;
  value: number;
}
export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface VolumePoint {
  time: number;
  value: number;
  color: string;
}

/** A linha usa o fechamento de cada candle. */
export function lineData(candles: readonly ChartCandle[]): LinePoint[] {
  return candles.map((c) => ({ time: toSeconds(c.start), value: reais(c.close) }));
}

export function candleData(candles: readonly ChartCandle[]): CandlePoint[] {
  return candles.map((c) => ({ time: toSeconds(c.start), open: reais(c.open), high: reais(c.high), low: reais(c.low), close: reais(c.close) }));
}

/**
 * O volume financeiro (R$) de cada período, colorido pela direção do candle: alta (fechou acima da abertura) ou baixa; sem
 * variação fica como alta. É o valor negociado (preço × quantidade somados), como nos home brokers, e não a quantidade de ações.
 */
export function volumeData(candles: readonly ChartCandle[], colors: { up: string; down: string }): VolumePoint[] {
  return candles.map((c) => ({ time: toSeconds(c.start), value: reais(c.turnover), color: c.close >= c.open ? colors.up : colors.down }));
}

/** Reais no formato curto do eixo do volume: `R$ 850`, `R$ 2,4 mil`, `R$ 1,2 mi`, `R$ 3 bi`. */
export function formatShortMoney(valueInReais: number): string {
  const abs = Math.abs(valueInReais);
  const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  if (abs < 1000) return `R$ ${fmt(Math.round(valueInReais))}`;
  if (abs < 1_000_000) return `R$ ${fmt(valueInReais / 1000)} mil`;
  if (abs < 1_000_000_000) return `R$ ${fmt(valueInReais / 1_000_000)} mi`;
  return `R$ ${fmt(valueInReais / 1_000_000_000)} bi`;
}

export type CandleUpdate =
  | { kind: "replace"; candles: ChartCandle[] }
  /** O candle é de um período mais novo que o último da série (virada): a janela é relida pela REST. */
  | { kind: "reload" }
  | { kind: "ignore" };

/**
 * Aplica o `candle` do canal `club:<ticker>` à série. O evento traz valores absolutos do candle, então aplicar duas vezes
 * não muda nada: o mesmo candle é substituído, um de outro intervalo ou de um período velho que a série não tem é
 * ignorado, e um período mais novo que o último pede a recarga (o servidor preenche os períodos sem negócio).
 */
export function applyCandleEvent(candles: readonly ChartCandle[], interval: "15m" | "1d", event: CandleEvent): CandleUpdate {
  if (event.interval !== interval) return { kind: "ignore" };
  const last = candles[candles.length - 1];
  if (!last) return { kind: "reload" };
  const eventStart = Date.parse(event.start);
  const lastStart = Date.parse(last.start);
  if (eventStart > lastStart) return { kind: "reload" };
  const index = candles.findIndex((c) => Date.parse(c.start) === eventStart);
  if (index < 0) return { kind: "ignore" };
  const next = candles.slice();
  next[index] = { start: candles[index]!.start, open: event.open, high: event.high, low: event.low, close: event.close, volume: event.volume, turnover: event.turnover };
  return { kind: "replace", candles: next };
}
