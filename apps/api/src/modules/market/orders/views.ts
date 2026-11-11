import { sql } from "drizzle-orm";
import type { MyOrder } from "@futbolsa/contracts";
import type { WalletRow } from "../../../infra/db/index.js";
import { clubs } from "../../../infra/db/schema/index.js";
import type { CashView, OrderRecord } from "../matching/matching-engine.js";

/** A ordem como o próprio dono a vê nas rotas (`myOrderSchema`): sem carteira, instantes em ISO 8601. */
export function myOrderView(order: OrderRecord): MyOrder {
  return {
    id: order.id,
    ticker: order.ticker,
    side: order.side,
    type: order.type,
    quantity: order.quantity,
    filled: order.filled,
    limitPrice: order.limitPrice,
    reservedCash: order.reservedCash,
    status: order.status,
    cancelReason: order.cancelReason,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

/** O caixa de uma carteira: total, reservado e livre (o mesmo desenho do IPO). */
export function cashOf(wallet: Pick<WalletRow, "cash" | "reservedCash">): CashView {
  return { total: wallet.cash, reserved: wallet.reservedCash, free: wallet.cash - wallet.reservedCash };
}

/**
 * O ticker de um clube com ordem: `clubs.ticker` é nulo só em clube que nunca foi listado, e ordem só existe em clube
 * listado. Para as consultas que juntam `orders` e `clubs`.
 */
export const listedTicker = sql<string>`${clubs.ticker}`;
