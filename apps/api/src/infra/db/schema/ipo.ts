import { sql } from "drizzle-orm";
import { check, integer, primaryKey, text, unique } from "drizzle-orm/pg-core";
import { bigId, futbolsa, instant, money, oneOf } from "./base.js";
import { clubs, seasons } from "./admin.js";
import { wallets } from "./portfolio.js";
import { IPO_BID_STATUSES } from "./values.js";

/** Dono: módulo `ipo` (IPO por bookbuilding). */

export const ipoBids = futbolsa.table(
  "ipo_bids",
  {
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
    quantity: integer("quantity").notNull(),
    maxPrice: money("max_price").notNull(),
    /** quantidade × min(preço máximo, teto da faixa). */
    reserved: money("reserved").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: instant("created_at").notNull(),
    /** Desempate do rateio: a última alteração. */
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    // uma oferta por clube por carteira
    unique("ipo_bids_season_club_wallet_key").on(t.seasonId, t.clubId, t.walletId),
    check("ipo_bids_status_check", oneOf(t.status, IPO_BID_STATUSES)),
    check("ipo_bids_values_check", sql`${t.quantity} > 0 and ${t.maxPrice} > 0 and ${t.reserved} >= 0`),
  ],
);

/** Resultado do IPO de cada clube. Existir = clube já liquidado (liquidação repetível). */
export const ipoResults = futbolsa.table(
  "ipo_results",
  {
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    cutPrice: money("cut_price").notNull(),
    demandAtCut: integer("demand_at_cut").notNull(),
    /** Fração do rateio, exata: numerador ÷ denominador. */
    allocationNum: bigId("allocation_num").notNull(),
    allocationDen: bigId("allocation_den").notNull(),
    /** Sobra do IPO que foi para a tesouraria. */
    treasuryShares: integer("treasury_shares").notNull(),
    /** Lote do formador, recebido pela tesouraria sem pagar. */
    mmLotShares: integer("mm_lot_shares").notNull(),
    settledAt: instant("settled_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.clubId] }),
    check("ipo_results_values_check", sql`${t.cutPrice} > 0 and ${t.allocationDen} > 0 and ${t.treasuryShares} >= 0 and ${t.mmLotShares} >= 0`),
  ],
);

export const ipoAllocations = futbolsa.table(
  "ipo_allocations",
  {
    bidId: bigId("bid_id")
      .primaryKey()
      .references(() => ipoBids.id),
    shares: integer("shares").notNull(),
    paid: money("paid").notNull(),
    refunded: money("refunded").notNull(),
  },
  (t) => [check("ipo_allocations_values_check", sql`${t.shares} >= 0 and ${t.paid} >= 0 and ${t.refunded} >= 0`)],
);
