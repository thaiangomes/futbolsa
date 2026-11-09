import { and, eq, sql } from "drizzle-orm";
import { settlement, type Cents } from "@futbolsa/engine";
import type { Tx } from "../../../infra/db/index.js";
import { orders } from "../../../infra/db/schema/index.js";
import type { OrderCancelReason, OrderStatus } from "../../../infra/db/schema/index.js";
import type { PortfolioLedger } from "../../portfolio/index.js";
import type { PostResult } from "../../portfolio/ledger/index.js";
import { insertTradeRow } from "../book/book-repo.js";
import type { OrderRecord, TradeRecord } from "./matching-engine.js";

/**
 * A liquidação de um negócio no banco, separada do casamento para servir à ordem nova e ao fim do leilão (L5):
 * grava o negócio, as duas linhas `trade` do extrato pela `settlement` do motor e o andamento das ordens que já
 * estavam no livro. Quem chama já travou o clube e as duas carteiras.
 */

/** O `ref_type` das linhas do extrato do mercado: a ordem (reserva e devolução) e o negócio. */
export const ORDER_REF = "order";
export const TRADE_REF = "trade";

/** Um lado do negócio. */
export interface TradeSide {
  orderId: number;
  walletId: number;
  type: "limit" | "market";
  /** Nulo na ordem a mercado. */
  limitPrice: Cents | null;
  /**
   * A ordem já estava aberta no livro: o negócio soma no `filled` dela e, quando ela termina, vira `filled` e
   * sai da conta de ordens abertas da carteira. A ordem que acabou de chegar não: quem chama a grava de uma vez,
   * já com o resultado do casamento.
   */
  resting: boolean;
}

export interface TradeToSettle {
  seasonId: number;
  clubId: number;
  ticker: string;
  at: Date;
  price: Cents;
  quantity: number;
  buy: TradeSide;
  sell: TradeSide;
  /** A tesouraria está num dos lados. */
  withHouse: boolean;
  /** O preço exibido antes deste negócio (no leilão, o de antes dele, em todos os negócios). */
  priceBefore: Cents;
  inAuction: boolean;
}

export interface SettledTrade {
  trade: TradeRecord;
  /** As linhas do extrato do comprador e do vendedor, nessa ordem. */
  posts: [buyer: PostResult, seller: PostResult];
  /** As ordens do livro (`resting`) como ficaram depois do negócio. */
  bookOrders: OrderRecord[];
}

type OrderRow = typeof orders.$inferSelect;

/** A linha de `orders` na forma que o motor de ordens devolve. */
export function toOrderRecord(row: OrderRow, ticker: string): OrderRecord {
  return {
    id: row.id,
    walletId: row.walletId,
    ticker,
    side: row.side as "buy" | "sell",
    type: row.type as "limit" | "market",
    quantity: row.quantity,
    filled: row.filled,
    limitPrice: row.limitPrice,
    reservedCash: row.reservedCash,
    status: row.status as OrderStatus,
    cancelReason: row.cancelReason as OrderCancelReason | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Soma a quantidade executada numa ordem aberta do livro, numa instrução só: `filled` anda, a ordem vira `filled`
 * quando completa, e a compra limitada passa a prender só o que falta × o preço limite. A condição
 * `status = 'open'` confere que o livro lido é o do banco: sem linha de volta, é erro de programação (o clube
 * travado garante que a ordem não mudou desde a leitura).
 */
async function fillBookOrder(tx: Tx, side: TradeSide, quantity: number, at: Date): Promise<OrderRow> {
  const [row] = await tx.db
    .update(orders)
    .set({
      filled: sql`${orders.filled} + ${quantity}`,
      status: sql`case when ${orders.filled} + ${quantity} >= ${orders.quantity} then 'filled' else ${orders.status} end`,
      reservedCash: sql`case when ${orders.side} = 'buy' and ${orders.type} = 'limit'
        then (${orders.quantity} - ${orders.filled} - ${quantity}) * ${orders.limitPrice} else 0 end`,
      updatedAt: at,
    })
    .where(and(eq(orders.id, side.orderId), eq(orders.status, "open")))
    .returning();
  if (!row) throw new Error(`a ordem ${side.orderId} não está aberta no livro: negócio sem ordem`);
  if (row.walletId !== side.walletId) {
    throw new Error(`a ordem ${side.orderId} é da carteira ${row.walletId}, e o negócio veio com a ${side.walletId}`);
  }
  return row;
}

/**
 * Liquida um negócio (Livro de ofertas, "Reserva de caixa e de ações"): o comprador solta a reserva da parte
 * executada, paga o preço do negócio e recebe as ações (a diferença entre o limite e o preço volta para o livre);
 * o vendedor solta e entrega as ações reservadas e recebe o dinheiro. O custo e o resultado realizado saem do
 * `portfolio.post` (`purchase` na compra, `sale` na venda).
 */
export async function settleTrade(tx: Tx, ledger: PortfolioLedger, t: TradeToSettle): Promise<SettledTrade> {
  const tradeId = await insertTradeRow(tx, {
    seasonId: t.seasonId,
    clubId: t.clubId,
    at: t.at,
    price: t.price,
    quantity: t.quantity,
    buyOrderId: t.buy.orderId,
    sellOrderId: t.sell.orderId,
    buyerWalletId: t.buy.walletId,
    sellerWalletId: t.sell.walletId,
    withHouse: t.withHouse,
    priceBefore: t.priceBefore,
    inAuction: t.inAuction,
  });

  const bookOrders: OrderRecord[] = [];
  // A ordem do livro que termina com este negócio deixa de contar no limite de 50 da carteira dela.
  const closes = { buy: 0, sell: 0 };
  for (const which of ["buy", "sell"] as const) {
    const side = t[which];
    if (!side.resting) continue;
    const row = await fillBookOrder(tx, side, t.quantity, t.at);
    if (row.status === "filled") closes[which] = -1;
    bookOrders.push(toOrderRecord(row, t.ticker));
  }

  const delta = settlement({ price: t.price, quantity: t.quantity }, { type: t.buy.type, limitPrice: t.buy.limitPrice ?? undefined });
  const ref = { type: TRADE_REF, id: tradeId };
  const buyer = await ledger.post(tx, {
    walletId: t.buy.walletId,
    at: t.at,
    kind: "trade",
    clubId: t.clubId,
    cashDelta: delta.buyer.cash,
    reservedCashDelta: delta.buyer.reservedCash,
    sharesDelta: delta.buyer.shares,
    reservedSharesDelta: delta.buyer.reservedShares,
    price: t.price,
    costBasis: "purchase",
    openOrdersDelta: closes.buy,
    ref,
  });
  const seller = await ledger.post(tx, {
    walletId: t.sell.walletId,
    at: t.at,
    kind: "trade",
    clubId: t.clubId,
    cashDelta: delta.seller.cash,
    reservedCashDelta: delta.seller.reservedCash,
    sharesDelta: delta.seller.shares,
    reservedSharesDelta: delta.seller.reservedShares,
    price: t.price,
    costBasis: "sale",
    openOrdersDelta: closes.sell,
    ref,
  });

  return {
    trade: {
      id: tradeId,
      at: t.at,
      price: t.price,
      quantity: t.quantity,
      buyOrderId: t.buy.orderId,
      sellOrderId: t.sell.orderId,
      buyerWalletId: t.buy.walletId,
      sellerWalletId: t.sell.walletId,
      withHouse: t.withHouse,
      priceBefore: t.priceBefore,
      inAuction: t.inAuction,
    },
    posts: [buyer, seller],
    bookOrders,
  };
}
