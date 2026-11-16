import { sql } from "drizzle-orm";
import { applyTrade, candleStart, type CandleInterval, type Cents } from "@futbolsa/engine";
import type { Tx } from "../../../infra/db/transaction.js";
import { candles } from "../../../infra/db/schema/index.js";

/** Um candle como ficou no banco depois do negócio (para o evento `candle`). */
export interface CandleRecord {
  clubId: number;
  interval: CandleInterval;
  start: Date;
  open: Cents;
  high: Cents;
  low: Cents;
  close: Cents;
  volume: number;
  /** O valor negociado no período, em centavos (preço × quantidade somados). */
  turnover: number;
}

const INTERVALS: readonly CandleInterval[] = ["15m", "1d"];

/**
 * Atualiza os candles de 15 minutos e do dia com um negócio (P8 do Plano do livro de ofertas e formador): o `market`
 * chama a cada negócio, dentro da transação, e o `portfolio` é o dono da tabela. A conta é a de `applyTrade` do
 * motor: abertura = primeiro negócio do período, máxima e mínima, fechamento = o último, volume somado. Um upsert só
 * por período (`ON CONFLICT ... DO UPDATE`), então dois negócios ao mesmo tempo nunca perdem volume. O dia é de 0h a
 * 24h de Brasília. Devolve os dois candles como ficaram, na ordem 15 minutos e dia.
 */
export async function recordTrade(
  tx: Tx,
  trade: { clubId: number; at: Date; price: Cents; quantity: number },
): Promise<CandleRecord[]> {
  const out: CandleRecord[] = [];
  for (const interval of INTERVALS) {
    // `applyTrade` valida preço e quantidade e devolve o candle de um negócio só (o ponto de partida do upsert)
    const first = applyTrade(undefined, interval, trade.at.getTime(), trade.price, trade.quantity);
    const [row] = await tx.db
      .insert(candles)
      .values({
        clubId: trade.clubId,
        interval,
        start: new Date(candleStart(interval, trade.at.getTime())),
        open: first.open,
        high: first.high,
        low: first.low,
        close: first.close,
        volume: first.volume,
        turnover: trade.price * trade.quantity,
      })
      .onConflictDoUpdate({
        target: [candles.clubId, candles.interval, candles.start],
        set: {
          high: sql`greatest(${candles.high}, excluded.high)`,
          low: sql`least(${candles.low}, excluded.low)`,
          close: sql`excluded.close`,
          volume: sql`${candles.volume} + excluded.volume`,
          turnover: sql`${candles.turnover} + excluded.turnover`,
        },
      })
      .returning();
    out.push({ clubId: row!.clubId, interval, start: row!.start, open: row!.open, high: row!.high, low: row!.low, close: row!.close, volume: row!.volume, turnover: row!.turnover });
  }
  return out;
}
