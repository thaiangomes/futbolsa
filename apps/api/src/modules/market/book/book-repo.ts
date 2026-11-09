import { and, asc, desc, eq, gt, gte, lt, lte, or, sql } from "drizzle-orm";
import { BOOK_DEPTH, RECENT_TRADES, type BookLevel, type PublicTrade } from "@futbolsa/contracts";
import type { Cents } from "@futbolsa/engine";
import type { Database, DrizzleTx, Tx } from "../../../infra/db/index.js";
import { orders, seasonClubs, trades } from "../../../infra/db/schema/index.js";
import type { OrderCancelReason, OrderStatus } from "../../../infra/db/schema/index.js";
import { toPublicTrades } from "./book-view.js";

type Db = Database | DrizzleTx;

/**
 * O livro no banco: leituras com índice e as primitivas de escrita do motor de ordens. Quem decide o que gravar é
 * o `MatchingEngine`; aqui só se lê e se grava, sempre com o clube já travado (as leituras do livro de outros
 * clubes não precisam de trava).
 */

/** Uma ordem aberta do outro lado do livro, na forma que o casamento pede (`walletId` vira o dono). */
export interface BookOrder {
  id: number;
  walletId: number;
  side: "buy" | "sell";
  limitPrice: Cents;
  /** O que falta executar. */
  remaining: number;
}

/** De onde continuar a leitura em páginas: a última ordem lida (prioridade preço-tempo). */
export interface BookCursor {
  limitPrice: Cents;
  id: number;
}

export interface OppositeSideRequest {
  clubId: number;
  /** O lado da ordem que chega: ela lê o lado oposto. */
  incomingSide: "buy" | "sell";
  /** O preço da ordem (limite da limitada ou da faixa da ordem a mercado); sem ele, lê o livro inteiro do lado. */
  price?: Cents;
  after?: BookCursor;
}

/**
 * A consulta do outro lado em ordem de prioridade (melhor preço; no mesmo preço, a ordem mais antiga) só até o
 * preço da ordem. Usa `orders_book_idx` (clube, lado, preço, id, só as abertas), e `after` continua de onde a
 * página anterior parou, sem repetir nem pular.
 */
export function oppositeSideQuery(db: Db, req: OppositeSideRequest, pageSize: number) {
  const buying = req.incomingSide === "buy";
  const side = buying ? "sell" : "buy";
  const conditions = [eq(orders.clubId, req.clubId), eq(orders.side, side), eq(orders.status, "open")];
  if (req.price !== undefined) conditions.push(buying ? lte(orders.limitPrice, req.price) : gte(orders.limitPrice, req.price));
  if (req.after) {
    const { limitPrice, id } = req.after;
    conditions.push(
      buying
        ? or(gt(orders.limitPrice, limitPrice), and(eq(orders.limitPrice, limitPrice), gt(orders.id, id)))!
        : or(lt(orders.limitPrice, limitPrice), and(eq(orders.limitPrice, limitPrice), gt(orders.id, id)))!,
    );
  }
  return db
    .select({ id: orders.id, walletId: orders.walletId, side: orders.side, limitPrice: orders.limitPrice, quantity: orders.quantity, filled: orders.filled })
    .from(orders)
    .where(and(...conditions))
    .orderBy(buying ? asc(orders.limitPrice) : desc(orders.limitPrice), asc(orders.id))
    .limit(pageSize);
}

/** Lê uma página do outro lado. `pageSize` padrão de 200 ordens. */
export async function readOppositeSide(db: Db, req: OppositeSideRequest, pageSize = 200): Promise<BookOrder[]> {
  const rows = await oppositeSideQuery(db, req, pageSize);
  return rows.map((r) => ({
    id: r.id,
    walletId: r.walletId,
    side: r.side as "buy" | "sell",
    limitPrice: r.limitPrice!,
    remaining: r.quantity - r.filled,
  }));
}

/** As ordens abertas de uma carteira num clube (a regra de ordem contra si mesmo olha só as do lado oposto). */
export async function myOpenOrdersInClub(
  db: Db,
  walletId: number,
  clubId: number,
): Promise<{ id: number; side: "buy" | "sell"; limitPrice: Cents; remaining: number }[]> {
  const rows = await db
    .select({ id: orders.id, side: orders.side, limitPrice: orders.limitPrice, quantity: orders.quantity, filled: orders.filled })
    .from(orders)
    .where(and(eq(orders.walletId, walletId), eq(orders.clubId, clubId), eq(orders.status, "open")))
    .orderBy(asc(orders.id));
  return rows.map((r) => ({ id: r.id, side: r.side as "buy" | "sell", limitPrice: r.limitPrice!, remaining: r.quantity - r.filled }));
}

/**
 * Os 5 melhores preços de cada lado, somados no banco (o livro pode ter milhares de ordens): a quantidade é o que
 * falta executar e o número de ordens é a contagem do preço. Sem dono.
 */
export async function readBookLevels(db: Db, clubId: number, depth = BOOK_DEPTH): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
  const side = async (which: "buy" | "sell"): Promise<BookLevel[]> => {
    const rows = await db
      .select({
        price: orders.limitPrice,
        quantity: sql<number>`sum(${orders.quantity} - ${orders.filled})::int`,
        orders: sql<number>`count(*)::int`,
      })
      .from(orders)
      .where(and(eq(orders.clubId, clubId), eq(orders.side, which), eq(orders.status, "open")))
      .groupBy(orders.limitPrice)
      .orderBy(which === "buy" ? desc(orders.limitPrice) : asc(orders.limitPrice))
      .limit(depth);
    return rows.map((r) => ({ price: r.price!, quantity: r.quantity, orders: r.orders }));
  };
  const [bids, asks] = await Promise.all([side("buy"), side("sell")]);
  return { bids, asks };
}

/**
 * Os últimos negócios do clube como o público os vê. Junto de `lastTradeUntil` (preço do passado), é o único lugar
 * que lê `trades` por clube, para a F14 acrescentar o filtro dos negócios anulados sem caçar consultas.
 */
export async function readRecentTrades(db: Db, clubId: number, limit = RECENT_TRADES): Promise<PublicTrade[]> {
  const rows = await db
    .select({ id: trades.id, at: trades.at, price: trades.price, quantity: trades.quantity })
    .from(trades)
    .where(eq(trades.clubId, clubId))
    .orderBy(desc(trades.at), desc(trades.id))
    .limit(limit);
  return toPublicTrades(rows, limit);
}

// ---------------------------------------------------------------- escrita

export interface NewOrderRow {
  seasonId: number;
  clubId: number;
  walletId: number;
  side: "buy" | "sell";
  type: "limit" | "market";
  quantity: number;
  limitPrice: Cents | null;
  reservedCash: Cents;
  status: OrderStatus;
  cancelReason?: OrderCancelReason | null;
  filled?: number;
  at: Date;
  idempotencyKey?: string | null;
}

export async function insertOrderRow(tx: Tx, o: NewOrderRow): Promise<number> {
  const [row] = await tx.db
    .insert(orders)
    .values({
      seasonId: o.seasonId,
      clubId: o.clubId,
      walletId: o.walletId,
      side: o.side,
      type: o.type,
      quantity: o.quantity,
      filled: o.filled ?? 0,
      limitPrice: o.limitPrice,
      reservedCash: o.reservedCash,
      status: o.status,
      cancelReason: o.cancelReason ?? null,
      createdAt: o.at,
      updatedAt: o.at,
      idempotencyKey: o.idempotencyKey ?? null,
    })
    .returning({ id: orders.id });
  return row!.id;
}

export interface NewTradeRow {
  seasonId: number;
  clubId: number;
  at: Date;
  price: Cents;
  quantity: number;
  buyOrderId: number;
  sellOrderId: number;
  buyerWalletId: number;
  sellerWalletId: number;
  withHouse: boolean;
  /** O preço exibido antes do negócio (no leilão, o de antes dele, em todos os negócios). */
  priceBefore: Cents;
  inAuction: boolean;
}

export async function insertTradeRow(tx: Tx, t: NewTradeRow): Promise<number> {
  const [row] = await tx.db.insert(trades).values(t).returning({ id: trades.id });
  return row!.id;
}

/** Atualiza o que mudou numa ordem: quanto executou, o estado, a reserva que ainda prende e o motivo do cancelamento. */
export async function updateOrderProgress(
  tx: Tx,
  orderId: number,
  p: { filled: number; status: OrderStatus; reservedCash: Cents; at: Date; cancelReason?: OrderCancelReason | null },
): Promise<void> {
  await tx.db
    .update(orders)
    .set({ filled: p.filled, status: p.status, reservedCash: p.reservedCash, updatedAt: p.at, ...(p.cancelReason !== undefined ? { cancelReason: p.cancelReason } : {}) })
    .where(eq(orders.id, orderId));
}

/** O preço exibido do clube passa a ser o do último negócio. Quem chama já travou a linha do clube. */
export async function setClubPrice(tx: Tx, seasonId: number, clubId: number, price: Cents, at: Date): Promise<void> {
  await tx.db
    .update(seasonClubs)
    .set({ lastPrice: price, lastTradeAt: at })
    .where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubId)));
}
