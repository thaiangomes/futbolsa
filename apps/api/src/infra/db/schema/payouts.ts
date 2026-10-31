import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, text, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { bigId, futbolsa, instant, money, oneOf } from "./base.js";
import { users } from "./accounts.js";
import { clubs, seasons } from "./admin.js";
import { walletEntries, wallets } from "./portfolio.js";
import { COMPETITIONS, PAYOUT_KINDS, PAYOUT_STATUSES } from "./values.js";

/**
 * Dono: módulo `admin` (pagamentos: quem recebe, aprovação, correção e estorno).
 * Os valores e o instante de fechamento vêm do `dividends`.
 */

export const payoutEvents = futbolsa.table(
  "payout_events",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    /** A chave estável do `PayoutEvent` do motor, igual entre as versões de uma correção. */
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull(),
    /** Por exemplo, "6 pontos, rodada 16, 12 (adiado)". */
    reason: text("reason").notNull(),
    competition: text("competition"),
    round: integer("round"),
    phase: text("phase"),
    perShare: money("per_share").notNull(),
    /** O instante que define quem recebe. */
    closedAt: instant("closed_at").notNull(),
    status: text("status").notNull().default("pending"),
    version: integer("version").notNull().default(1),
    supersedesId: bigId("supersedes_id").references((): AnyPgColumn => payoutEvents.id),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: instant("approved_at"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    // um evento vigente por clube e chave: rodar a tarefa duas vezes não duplica
    uniqueIndex("payout_events_current_key")
      .on(t.seasonId, t.clubId, t.eventKey)
      .where(sql`${t.status} <> 'superseded'`),
    index("payout_events_season_status_idx").on(t.seasonId, t.status),
    check("payout_events_kind_check", oneOf(t.kind, PAYOUT_KINDS)),
    check("payout_events_status_check", oneOf(t.status, PAYOUT_STATUSES)),
    check("payout_events_competition_check", sql`${t.competition} is null or ${oneOf(t.competition, COMPETITIONS)}`),
    check("payout_events_values_check", sql`${t.perShare} >= 0 and ${t.version} >= 1`),
  ],
);

/** Foto das posições no fechamento do evento (sem a tesouraria). Histórico. */
export const payoutHoldings = futbolsa.table(
  "payout_holdings",
  {
    eventId: bigId("event_id")
      .notNull()
      .references(() => payoutEvents.id),
    walletId: bigId("wallet_id")
      .notNull()
      .references(() => wallets.id),
    shares: integer("shares").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.walletId] }),
    check("payout_holdings_shares_check", sql`${t.shares} > 0`),
  ],
);

/** O que cada carteira recebeu (ou devolveu) por evento. Histórico. */
export const payoutCredits = futbolsa.table(
  "payout_credits",
  {
    eventId: bigId("event_id")
      .notNull()
      .references(() => payoutEvents.id),
    walletId: bigId("wallet_id")
      .notNull()
      .references(() => wallets.id),
    amount: money("amount").notNull(),
    entryId: bigId("entry_id")
      .notNull()
      .references(() => walletEntries.id),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.walletId] })],
);
