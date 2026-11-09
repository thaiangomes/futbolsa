import { BOOK_DEPTH, RECENT_TRADES, type BookLevel, type PublicTrade } from "@futbolsa/contracts";

/**
 * O que o jogador vê do livro (Livro de ofertas, "O que o jogador vê"): funções puras, sem dono, sem marca de casa
 * nem de bot. O banco entrega as linhas; aqui só se soma e se corta.
 */

export interface OpenOrderRow {
  side: "buy" | "sell";
  limitPrice: number;
  /** O que falta executar. */
  remaining: number;
}

/**
 * Os melhores preços de cada lado, com a quantidade somada e o número de ordens: as compras do maior preço para o
 * menor e as vendas do menor para o maior. A mesma função serve ao livro lido do banco e ao `book` publicado.
 */
export function aggregateBook(open: readonly OpenOrderRow[], depth = BOOK_DEPTH): { bids: BookLevel[]; asks: BookLevel[] } {
  const side = (which: "buy" | "sell"): BookLevel[] => {
    const byPrice = new Map<number, BookLevel>();
    for (const o of open) {
      if (o.side !== which) continue;
      const level = byPrice.get(o.limitPrice) ?? { price: o.limitPrice, quantity: 0, orders: 0 };
      level.quantity += o.remaining;
      level.orders += 1;
      byPrice.set(o.limitPrice, level);
    }
    return [...byPrice.values()].sort((a, b) => (which === "buy" ? b.price - a.price : a.price - b.price)).slice(0, depth);
  };
  return { bids: side("buy"), asks: side("sell") };
}

/**
 * Os últimos negócios como o público os vê: os mais recentes primeiro (no mesmo instante, o de maior `id`), com
 * hora, preço e quantidade, sem comprador nem vendedor.
 */
export function toPublicTrades(
  rows: readonly { id: number; at: Date; price: number; quantity: number }[],
  limit = RECENT_TRADES,
): PublicTrade[] {
  return [...rows]
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id)
    .slice(0, limit)
    .map((r) => ({ id: r.id, at: r.at.toISOString(), price: r.price, quantity: r.quantity }));
}
