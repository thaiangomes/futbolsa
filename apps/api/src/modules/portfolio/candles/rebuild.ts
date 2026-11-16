import { and, asc, eq, gte, sql } from "drizzle-orm";
import { applyTrade, type Candle, type CandleInterval, candleStart } from "@futbolsa/engine";
import type { Tx } from "../../../infra/db/transaction.js";
import { candles, trades } from "../../../infra/db/schema/index.js";

const INTERVALS: readonly CandleInterval[] = ["15m", "1d"];
/** Candles gravados por comando. */
const BATCH = 1000;

/**
 * Refaz os candles de 15 minutos e do dia do clube desde o período de `since` (o horário do negócio anulado mais
 * antigo), para a anulação de trapaça da F14 (Plano do admin de jogadores e bots, proposta 24 e "Decidir", passo 7).
 * Apaga os candles desde o começo do período de `since` em cada intervalo e os grava de novo com os negócios que
 * sobraram, sem os anulados (`trade_annulments`): ficam iguais aos de quem nunca teve esses negócios. A conta é a de
 * `applyTrade` do motor, na ordem do horário (no mesmo instante, a do `id`), a mesma de `recordTrade` e da invariante
 * dos testes. Os candles antes do período de `since` não mudam: os negócios deles ficam como estão.
 *
 * Quem chama já travou o clube na transação: nenhum negócio novo dele sai (nem grava candle) enquanto isto roda.
 * Devolve quantos candles ficaram gravados desde `since`, por intervalo.
 */
export async function rebuildCandles(tx: Tx, clubId: number, since: Date): Promise<Record<CandleInterval, number>> {
  const starts = new Map(INTERVALS.map((i) => [i, candleStart(i, since.getTime())]));
  const from = Math.min(...starts.values());
  const rows = await tx.db
    .select({ at: trades.at, price: trades.price, quantity: trades.quantity })
    .from(trades)
    .where(
      and(
        eq(trades.clubId, clubId),
        gte(trades.at, new Date(from)),
        sql`not exists (select 1 from futbolsa.trade_annulments ta where ta.trade_id = ${trades.id})`,
      ),
    )
    .orderBy(asc(trades.at), asc(trades.id));

  const out = {} as Record<CandleInterval, number>;
  for (const interval of INTERVALS) {
    const start = starts.get(interval)!;
    const byStart = new Map<number, Candle>();
    const turnoverOf = new Map<number, number>();
    for (const t of rows) {
      const at = t.at.getTime();
      if (at < start) continue;
      const key = candleStart(interval, at);
      byStart.set(key, applyTrade(byStart.get(key), interval, at, t.price, t.quantity));
      turnoverOf.set(key, (turnoverOf.get(key) ?? 0) + t.price * t.quantity);
    }
    await tx.db
      .delete(candles)
      .where(and(eq(candles.clubId, clubId), eq(candles.interval, interval), gte(candles.start, new Date(start))));
    const values = [...byStart.values()].map((c) => ({
      clubId,
      interval,
      start: new Date(c.start),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      turnover: turnoverOf.get(c.start) ?? 0,
    }));
    for (let i = 0; i < values.length; i += BATCH) await tx.db.insert(candles).values(values.slice(i, i + BATCH));
    out[interval] = values.length;
  }
  return out;
}
