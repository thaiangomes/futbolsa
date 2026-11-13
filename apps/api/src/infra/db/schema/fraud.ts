import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { bigId, futbolsa, instant, oneOf } from "./base.js";
import { users } from "./accounts.js";
import { clubs, seasons } from "./admin.js";
import { trades } from "./market.js";
import { wallets } from "./portfolio.js";
import { FRAUD_CASE_ORIGINS, FRAUD_CASE_STATUSES } from "./values.js";

/** Dono: módulo `admin` (trapaça entre contas, F14). Ninguém fora do `/admin` lê estas tabelas. */

export const fraudCases = futbolsa.table(
  "fraud_cases",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    origin: text("origin").notNull(),
    status: text("status").notNull().default("open"),
    /** O par de carteiras, em ordem de id (a ordem é do jogador A/B, não de quem comprou). */
    walletLow: bigId("wallet_low")
      .notNull()
      .references(() => wallets.id),
    walletHigh: bigId("wallet_high")
      .notNull()
      .references(() => wallets.id),
    /** Vazio no relatório manual de todos os clubes. */
    clubId: integer("club_id").references(() => clubs.id),
    periodFrom: instant("period_from").notNull(),
    periodTo: instant("period_to").notNull(),
    /** Vazio no alerta. */
    openedBy: uuid("opened_by").references(() => users.id),
    openedAt: instant("opened_at").notNull(),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: instant("decided_at"),
    decisionReason: text("decision_reason"),
    /** A foto do relatório na decisão: sem e-mail nem apelido (só ids). */
    report: jsonb("report"),
    reportHash: text("report_hash"),
  },
  (t) => [
    // um caso de alerta aberto por (temporada, clube, par)
    uniqueIndex("fraud_cases_open_alert_key")
      .on(t.seasonId, t.clubId, t.walletLow, t.walletHigh)
      .where(sql`${t.origin} = 'alert' and ${t.status} = 'open'`),
    index("fraud_cases_season_status_idx").on(t.seasonId, t.status),
    check("fraud_cases_origin_check", oneOf(t.origin, FRAUD_CASE_ORIGINS)),
    check("fraud_cases_status_check", oneOf(t.status, FRAUD_CASE_STATUSES)),
    check("fraud_cases_pair_check", sql`${t.walletLow} < ${t.walletHigh}`),
    check("fraud_cases_period_check", sql`${t.periodFrom} <= ${t.periodTo}`),
  ],
);

export const fraudCaseTrades = futbolsa.table(
  "fraud_case_trades",
  {
    caseId: bigId("case_id")
      .notNull()
      .references(() => fraudCases.id),
    tradeId: bigId("trade_id")
      .notNull()
      .references(() => trades.id),
    suspicious: boolean("suspicious").notNull().default(false),
    /** Marcado pelo admin na decisão. */
    selected: boolean("selected").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.tradeId] }), index("fraud_case_trades_trade_idx").on(t.tradeId)],
);

/** Advertência de trapaça: vale só a temporada dela. */
export const fraudWarnings = futbolsa.table(
  "fraud_warnings",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    caseId: bigId("case_id")
      .notNull()
      .references(() => fraudCases.id),
    at: instant("at").notNull(),
  },
  (t) => [uniqueIndex("fraud_warnings_user_case_key").on(t.userId, t.caseId), index("fraud_warnings_user_season_idx").on(t.userId, t.seasonId)],
);
