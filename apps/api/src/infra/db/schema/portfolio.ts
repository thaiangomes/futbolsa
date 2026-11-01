import { sql } from "drizzle-orm";
import { check, date, index, integer, jsonb, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bigId, futbolsa, instant, money, oneOf } from "./base.js";
import { users } from "./accounts.js";
import { bots, clubs, seasons } from "./admin.js";
import { CANDLE_INTERVALS, ENTRY_MODES, WALLET_ENTRY_KINDS, WALLET_OWNER_TYPES } from "./values.js";

/**
 * Dono: módulo `portfolio` (Carteira e gráficos). `wallets` e `positions` só mudam
 * pelo `portfolio.post`, que grava junto a linha de `wallet_entries` (histórico).
 */

export const wallets = futbolsa.table(
  "wallets",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    ownerType: text("owner_type").notNull(),
    userId: uuid("user_id").references(() => users.id),
    botId: integer("bot_id").references(() => bots.id),
    /** Pode ficar negativo só por estorno, e aí sem nada reservado. */
    cash: money("cash").notNull().default(0),
    reservedCash: money("reserved_cash").notNull().default(0),
    enteredAt: instant("entered_at").notNull(),
    entryMode: text("entry_mode"),
    /** Ordens abertas, para o limite de 50 (contado com a carteira travada). */
    openOrders: integer("open_orders").notNull().default(0),
  },
  (t) => [
    uniqueIndex("wallets_season_user_key").on(t.seasonId, t.userId),
    uniqueIndex("wallets_season_bot_key").on(t.seasonId, t.botId),
    uniqueIndex("wallets_season_treasury_key").on(t.seasonId).where(sql`${t.ownerType} = 'treasury'`),
    check("wallets_owner_type_check", oneOf(t.ownerType, WALLET_OWNER_TYPES)),
    check(
      "wallets_owner_check",
      sql`(${t.ownerType} = 'user' and ${t.userId} is not null and ${t.botId} is null)
        or (${t.ownerType} = 'bot' and ${t.botId} is not null and ${t.userId} is null)
        or (${t.ownerType} = 'treasury' and ${t.userId} is null and ${t.botId} is null)`,
    ),
    check("wallets_entry_mode_check", sql`${t.entryMode} is null or ${oneOf(t.entryMode, ENTRY_MODES)}`),
    check("wallets_reserved_cash_check", sql`${t.reservedCash} >= 0`),
    // caixa negativo (estorno) só sem nada reservado (critério 15 do Admin)
    check("wallets_cash_check", sql`${t.cash} >= ${t.reservedCash} or ${t.reservedCash} = 0`),
    check("wallets_open_orders_check", sql`${t.openOrders} >= 0`),
  ],
);

export const positions = futbolsa.table(
  "positions",
  {
    walletId: bigId("wallet_id")
      .notNull()
      .references(() => wallets.id),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    shares: integer("shares").notNull().default(0),
    /** Presas em ordens de venda abertas. */
    reservedShares: integer("reserved_shares").notNull().default(0),
    cost: money("cost").notNull().default(0),
    realized: money("realized").notNull().default(0),
    /** Dividendos recebidos na temporada, com estornos e complementos. */
    dividends: money("dividends").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.walletId, t.clubId] }),
    check("positions_shares_check", sql`${t.shares} >= ${t.reservedShares} and ${t.reservedShares} >= 0`),
    check("positions_cost_check", sql`${t.cost} >= 0`),
  ],
);

/** O extrato: cada movimento, com o caixa depois. Histórico que não se edita. */
export const walletEntries = futbolsa.table(
  "wallet_entries",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    walletId: bigId("wallet_id")
      .notNull()
      .references(() => wallets.id),
    at: instant("at").notNull(),
    kind: text("kind").notNull(),
    clubId: integer("club_id").references(() => clubs.id),
    cashDelta: money("cash_delta").notNull().default(0),
    reservedCashDelta: money("reserved_cash_delta").notNull().default(0),
    sharesDelta: integer("shares_delta").notNull().default(0),
    reservedSharesDelta: integer("reserved_shares_delta").notNull().default(0),
    price: money("price"),
    /** Resultado realizado da venda (ou da recompra). */
    realized: money("realized"),
    cashAfter: money("cash_after").notNull(),
    refType: text("ref_type"),
    refId: text("ref_id"),
    reason: text("reason"),
  },
  (t) => [
    index("wallet_entries_wallet_club_at_idx").on(t.walletId, t.clubId, t.at),
    index("wallet_entries_wallet_at_idx").on(t.walletId, t.at, t.id),
    check("wallet_entries_kind_check", oneOf(t.kind, WALLET_ENTRY_KINDS)),
  ],
);

/** Candles de 15 minutos e diários de cada clube, atualizados a cada negócio. */
export const candles = futbolsa.table(
  "candles",
  {
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    interval: text("interval").notNull(),
    start: instant("start").notNull(),
    open: money("open").notNull(),
    high: money("high").notNull(),
    low: money("low").notNull(),
    close: money("close").notNull(),
    volume: bigId("volume").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.clubId, t.interval, t.start] }),
    check("candles_interval_check", oneOf(t.interval, CANDLE_INTERVALS)),
  ],
);

/** Patrimônio de cada carteira às 24h de Brasília. */
export const equityDaily = futbolsa.table(
  "equity_daily",
  {
    walletId: bigId("wallet_id")
      .notNull()
      .references(() => wallets.id),
    day: date("day", { mode: "string" }).notNull(),
    equity: money("equity").notNull(),
  },
  (t) => [primaryKey({ columns: [t.walletId, t.day] })],
);

/** Foto mensal da carteira em décimos de ponto percentual, por clube e do caixa. */
export const portfolioSnapshots = futbolsa.table(
  "portfolio_snapshots",
  {
    walletId: bigId("wallet_id")
      .notNull()
      .references(() => wallets.id),
    month: text("month").notNull(),
    /** Por exemplo `{ "FLA3": 475, "cash": 525 }`. */
    slices: jsonb("slices").$type<Record<string, number>>().notNull(),
    takenAt: instant("taken_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.walletId, t.month] }),
    check("portfolio_snapshots_month_check", sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);
