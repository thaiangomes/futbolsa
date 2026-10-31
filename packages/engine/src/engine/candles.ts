import { dayStart, nextDayStart } from "./brasilia.js";
import { assertCents, type Cents } from "./money.js";

/**
 * Candles do gráfico de cada clube ([[Carteira e gráficos]]): de 15 minutos (hoje)
 * e diários (7 dias, 30 dias e temporada), com o dia de 0h a 24h de Brasília.
 * Abertura = primeiro negócio do período; fechamento = último; volume = ações
 * negociadas. A linha do gráfico usa o fechamento de cada candle.
 */

export type CandleInterval = "15m" | "1d";

export interface Candle {
  /** Início do período (ms desde 1970). */
  start: number;
  open: Cents;
  high: Cents;
  low: Cents;
  close: Cents;
  /** Ações negociadas no período. */
  volume: number;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/** Início do candle que contém `at`. Brasília (UTC−3) cai em múltiplos de 15 minutos de UTC. */
export function candleStart(interval: CandleInterval, at: number): number {
  if (interval === "1d") return dayStart(at);
  if (!Number.isFinite(at)) throw new Error(`Instante inválido: ${at}`);
  return Math.floor(at / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
}

/** Início do candle seguinte ao que começa em `start`. */
function nextStart(interval: CandleInterval, start: number): number {
  return interval === "1d" ? nextDayStart(start) : start + FIFTEEN_MIN_MS;
}

/** Aplica um negócio ao candle do período dele (cria o candle se ainda não há). */
export function applyTrade(
  candle: Candle | undefined,
  interval: CandleInterval,
  at: number,
  price: Cents,
  quantity: number,
): Candle {
  assertCents(price, "preço do negócio");
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Quantidade deve ser um inteiro positivo, recebido ${quantity}`);
  }
  const start = candleStart(interval, at);
  if (!candle) return { start, open: price, high: price, low: price, close: price, volume: quantity };
  if (candle.start !== start) {
    throw new Error("O negócio é de outro período: use o candle dele");
  }
  return {
    start,
    open: candle.open,
    high: Math.max(candle.high, price),
    low: Math.min(candle.low, price),
    close: price,
    volume: candle.volume + quantity,
  };
}

/**
 * Série contínua de `from` até `to` (inclusive os períodos que os contêm): o
 * período sem negócio repete o fechamento anterior com volume zero e, antes do
 * primeiro negócio, vale `startPrice` (o preço do IPO). `candles` pode ser
 * esparso e trazer períodos de antes da janela, que só servem de fechamento de partida.
 */
export function fillGaps(
  candles: readonly Candle[],
  interval: CandleInterval,
  from: number,
  to: number,
  startPrice: Cents,
): Candle[] {
  assertCents(startPrice, "preço de partida");
  if (to < from) throw new Error("A janela do gráfico está invertida");
  const first = candleStart(interval, from);
  const last = candleStart(interval, to);
  const byStart = new Map(candles.map((c) => [c.start, c]));

  let previousClose = startPrice;
  const earlier = candles.filter((c) => c.start < first).sort((a, b) => b.start - a.start)[0];
  if (earlier) previousClose = earlier.close;

  const series: Candle[] = [];
  for (let start = first; start <= last; start = nextStart(interval, start)) {
    const found = byStart.get(start);
    const candle: Candle = found ?? {
      start,
      open: previousClose,
      high: previousClose,
      low: previousClose,
      close: previousClose,
      volume: 0,
    };
    series.push(candle);
    previousClose = candle.close;
  }
  return series;
}
