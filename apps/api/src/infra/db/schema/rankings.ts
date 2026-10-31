import { sql } from "drizzle-orm";
import { boolean, check, integer, primaryKey, text, unique } from "drizzle-orm/pg-core";
import { bigId, futbolsa, instant, money, oneOf } from "./base.js";
import { seasons } from "./admin.js";
import { wallets } from "./portfolio.js";
import { RANKING_PERIODS } from "./values.js";

/** Dono: módulo `rankings`. Cada recálculo grava uma nova versão. */

export const rankingSnapshots = futbolsa.table(
  "ranking_snapshots",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    period: text("period").notNull(),
    /** `2027-06` ou `2027`. */
    periodKey: text("period_key").notNull(),
    closedAt: instant("closed_at").notNull(),
    botsIncluded: boolean("bots_included").notNull(),
    version: integer("version").notNull().default(1),
    reason: text("reason"),
    createdAt: instant("created_at").notNull(),
  },
  (t) => [
    unique("ranking_snapshots_version_key").on(t.seasonId, t.period, t.periodKey, t.version),
    check("ranking_snapshots_period_check", oneOf(t.period, RANKING_PERIODS)),
  ],
);

/** Linhas do ranking. O apelido não é guardado: a tela mostra o atual. Histórico. */
export const rankingRows = futbolsa.table(
  "ranking_rows",
  {
    snapshotId: bigId("snapshot_id")
      .notNull()
      .references(() => rankingSnapshots.id),
    walletId: bigId("wallet_id")
      .notNull()
      .references(() => wallets.id),
    base: money("base").notNull(),
    equity: money("equity").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.snapshotId, t.walletId] }),
    check("ranking_rows_values_check", sql`${t.base} > 0 and ${t.position} >= 1`),
  ],
);
