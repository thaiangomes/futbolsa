import { dayStart, type CandleInterval } from "@futbolsa/engine";
import type { ChartRange } from "@futbolsa/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChartWindow {
  interval: CandleInterval;
  /** Início da janela (ms), nunca antes da abertura da negociação. */
  from: number;
  /** Fim da janela (ms): o menor entre agora e o fim da negociação. */
  to: number;
  /** A negociação ainda não abriu: a resposta vem vazia. */
  beforeOpening: boolean;
}

/**
 * A janela de cada período do gráfico ([[Carteira e gráficos]]): `today` = candles de 15 minutos desde 0h de
 * Brasília; `7d` e `30d` = candles diários contando o dia de hoje (de 6 ou 29 dias antes de 0h); `season` = diários desde
 * a abertura da negociação. Nunca começa antes de `trading_opens_at` e termina no menor entre agora e o fim da negociação.
 */
export function chartWindow(range: ChartRange, now: Date, tradingOpensAt: Date | null, tradingEndedAt: Date | null): ChartWindow {
  const nowMs = now.getTime();
  const to = tradingEndedAt ? Math.min(nowMs, tradingEndedAt.getTime()) : nowMs;
  const interval: CandleInterval = range === "today" ? "15m" : "1d";
  if (tradingOpensAt === null || nowMs < tradingOpensAt.getTime()) {
    return { interval, from: nowMs, to: nowMs, beforeOpening: true };
  }
  const opens = tradingOpensAt.getTime();
  let from: number;
  if (range === "today") from = dayStart(nowMs);
  else if (range === "7d") from = dayStart(nowMs) - 6 * DAY_MS;
  else if (range === "30d") from = dayStart(nowMs) - 29 * DAY_MS;
  else from = dayStart(opens);
  return { interval, from: Math.max(from, opens), to: Math.max(to, opens), beforeOpening: false };
}
