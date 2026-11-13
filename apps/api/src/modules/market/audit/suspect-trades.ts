import { and, asc, eq, gte, lte, notExists, sql } from "drizzle-orm";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";
import { clubs, tradeAnnulments, trades } from "../../../infra/db/schema/index.js";

/**
 * Os negócios candidatos ao alerta de trapaça do admin (F14, T21). O `market` é o dono de `trades` e só ele os lê; o
 * `admin` aplica a regra (`findFraudAlerts`, do motor) e cuida dos casos. O filtro aqui é só o corte barato, em SQL,
 * com os mesmos limites de `isSuspiciousTrade` (até 10 ações, sem a casa, 5% ou mais longe do preço anterior, em
 * inteiros); a decisão final é do motor. Negócio já anulado não volta.
 */
export interface SuspectTradeRow {
  id: number;
  at: Date;
  clubId: number;
  ticker: string;
  quantity: number;
  price: number;
  priceBefore: number;
  inAuction: boolean;
  buyerWalletId: number;
  sellerWalletId: number;
}

type Db = Database | DrizzleTx;

/** Os limites repetem os do motor para o corte em SQL; o teste do alerta confere que as duas contas concordam. */
const MAX_SHARES = 10;
const MIN_MOVE_BP = 500;

export async function suspectTrades(db: Db, f: { seasonId: number; from: Date; to: Date }): Promise<SuspectTradeRow[]> {
  return db
    .select({
      id: trades.id,
      at: trades.at,
      clubId: trades.clubId,
      ticker: sql<string>`${clubs.ticker}`,
      quantity: trades.quantity,
      price: trades.price,
      priceBefore: trades.priceBefore,
      inAuction: trades.inAuction,
      buyerWalletId: trades.buyerWalletId,
      sellerWalletId: trades.sellerWalletId,
    })
    .from(trades)
    .innerJoin(clubs, eq(clubs.id, trades.clubId))
    .where(
      and(
        eq(trades.seasonId, f.seasonId),
        gte(trades.at, f.from),
        lte(trades.at, f.to),
        eq(trades.withHouse, false),
        sql`${trades.quantity} <= ${MAX_SHARES}`,
        sql`${trades.priceBefore} > 0`,
        sql`abs(${trades.price} - ${trades.priceBefore}) * 10000 >= ${MIN_MOVE_BP} * ${trades.priceBefore}`,
        notExists(db.select({ one: sql`1` }).from(tradeAnnulments).where(eq(tradeAnnulments.tradeId, trades.id))),
      ),
    )
    .orderBy(asc(trades.at), asc(trades.id));
}
