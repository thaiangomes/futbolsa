import type { MyTrade } from "@futbolsa/contracts";

/** O limite de negócios por resposta: os mais novos. O site junta os que caem no mesmo candle e lado. */
export const MY_TRADES_LIMIT = 500;

export interface TradeEntryRow {
  at: Date;
  kind: string;
  sharesDelta: number;
  cashDelta: number;
  price: number | null;
}

/**
 * Os meus negócios no clube, das linhas do extrato (`trade`, `ipo_settle`, `index_entry` e `buyback`): compra quando as
 * ações entram, venda quando saem. A alocação do IPO aparece "na abertura" (critério 27): usa o maior entre o horário da
 * liquidação e `trading_opens_at`. Ajuste do admin não é negócio. Do mais antigo para o mais novo.
 */
export function myTrades(rows: readonly TradeEntryRow[], tradingOpensAt: Date | null): MyTrade[] {
  const out: MyTrade[] = [];
  for (const r of rows) {
    if (r.sharesDelta === 0) continue;
    if (!["trade", "ipo_settle", "index_entry", "buyback"].includes(r.kind)) continue;
    const quantity = Math.abs(r.sharesDelta);
    const price = r.price ?? Math.round(Math.abs(r.cashDelta) / quantity);
    const at = r.kind === "ipo_settle" && tradingOpensAt && tradingOpensAt.getTime() > r.at.getTime() ? tradingOpensAt : r.at;
    out.push({ at: at.toISOString(), side: r.sharesDelta > 0 ? "buy" : "sell", quantity, price });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at)).slice(-MY_TRADES_LIMIT);
}
