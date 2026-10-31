import { sql } from "drizzle-orm";
import { boolean, check, index, integer, text } from "drizzle-orm/pg-core";
import { bigId, futbolsa, instant, money, oneOf } from "./base.js";
import { clubs, seasons } from "./admin.js";
import { wallets } from "./portfolio.js";
import { ORDER_CANCEL_REASONS, ORDER_SIDES, ORDER_STATUSES, ORDER_TYPES, REFRESH_REASONS } from "./values.js";

/** Dono: módulo `market` (Livro de ofertas e formador de mercado). */

export const orders = futbolsa.table(
  "orders",
  {
    /** A sequência é também a prioridade de tempo. */
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    walletId: bigId("wallet_id")
      .notNull()
      .references(() => wallets.id),
    side: text("side").notNull(),
    type: text("type").notNull(),
    quantity: integer("quantity").notNull(),
    filled: integer("filled").notNull().default(0),
    limitPrice: money("limit_price"),
    reservedCash: money("reserved_cash").notNull().default(0),
    status: text("status").notNull().default("open"),
    cancelReason: text("cancel_reason"),
    createdAt: instant("created_at").notNull(),
    updatedAt: instant("updated_at").notNull(),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [
    // o livro: só as abertas, na ordem de prioridade
    index("orders_book_idx").on(t.clubId, t.side, t.limitPrice, t.id).where(sql`${t.status} = 'open'`),
    index("orders_wallet_open_idx").on(t.walletId).where(sql`${t.status} = 'open'`),
    index("orders_wallet_created_idx").on(t.walletId, t.createdAt),
    check("orders_side_check", oneOf(t.side, ORDER_SIDES)),
    check("orders_type_check", oneOf(t.type, ORDER_TYPES)),
    check("orders_status_check", oneOf(t.status, ORDER_STATUSES)),
    check("orders_cancel_reason_check", sql`${t.cancelReason} is null or ${oneOf(t.cancelReason, ORDER_CANCEL_REASONS)}`),
    check("orders_quantity_check", sql`${t.quantity} > 0 and ${t.filled} >= 0 and ${t.filled} <= ${t.quantity}`),
    // a limitada tem preço; a de mercado não
    check(
      "orders_limit_price_check",
      sql`(${t.type} = 'limit' and ${t.limitPrice} > 0) or (${t.type} = 'market' and ${t.limitPrice} is null)`,
    ),
    check("orders_reserved_cash_check", sql`${t.reservedCash} >= 0`),
  ],
);

/** Negócios. Histórico que não se edita. */
export const trades = futbolsa.table(
  "trades",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    at: instant("at").notNull(),
    price: money("price").notNull(),
    quantity: integer("quantity").notNull(),
    buyOrderId: bigId("buy_order_id")
      .notNull()
      .references(() => orders.id),
    sellOrderId: bigId("sell_order_id")
      .notNull()
      .references(() => orders.id),
    buyerWalletId: bigId("buyer_wallet_id")
      .notNull()
      .references(() => wallets.id),
    sellerWalletId: bigId("seller_wallet_id")
      .notNull()
      .references(() => wallets.id),
    withHouse: boolean("with_house").notNull().default(false),
  },
  (t) => [
    index("trades_club_at_idx").on(t.clubId, t.at),
    index("trades_season_at_idx").on(t.seasonId, t.at),
    check("trades_values_check", sql`${t.price} > 0 and ${t.quantity} > 0`),
  ],
);

/** Pedidos de reposição da casa por evento, gravados na transação do evento. */
export const marketRefreshRequests = futbolsa.table(
  "market_refresh_requests",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    reason: text("reason").notNull(),
    requestedAt: instant("requested_at").notNull(),
    doneAt: instant("done_at"),
  },
  (t) => [
    index("market_refresh_requests_pending_idx").on(t.clubId).where(sql`${t.doneAt} is null`),
    check("market_refresh_requests_reason_check", oneOf(t.reason, REFRESH_REASONS)),
  ],
);
