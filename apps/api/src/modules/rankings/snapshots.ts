import { and, desc, eq, sql } from "drizzle-orm";
import type { Cents } from "@futbolsa/engine";
import type { Tx } from "../../infra/db/transaction.js";
import { rankingRows, rankingSnapshots } from "../../infra/db/schema/index.js";

export type Period = "month" | "season";

export interface SnapshotHead {
  id: number;
  period: Period;
  periodKey: string;
  closedAt: Date;
  botsIncluded: boolean;
  version: number;
}

export interface StoredRow {
  walletId: number;
  base: Cents;
  equity: Cents;
  position: number;
}

type Reader = Pick<Tx, "db">;

/** A versão atual (a maior) de um ranking oficial, ou `null` se ele ainda não foi fechado. */
export async function currentSnapshot(tx: Reader, seasonId: number, period: Period, periodKey: string): Promise<SnapshotHead | null> {
  const [s] = await tx.db
    .select()
    .from(rankingSnapshots)
    .where(and(eq(rankingSnapshots.seasonId, seasonId), eq(rankingSnapshots.period, period), eq(rankingSnapshots.periodKey, periodKey)))
    .orderBy(desc(rankingSnapshots.version))
    .limit(1);
  return s ? { id: s.id, period: s.period as Period, periodKey: s.periodKey, closedAt: s.closedAt, botsIncluded: s.botsIncluded, version: s.version } : null;
}

export async function rowsOfSnapshot(tx: Reader, snapshotId: number): Promise<StoredRow[]> {
  const rows = await tx.db.select().from(rankingRows).where(eq(rankingRows.snapshotId, snapshotId)).orderBy(rankingRows.position, rankingRows.walletId);
  return rows.map((r) => ({ walletId: r.walletId, base: r.base, equity: r.equity, position: r.position }));
}

/** As linhas da versão atual de um ranking, por carteira; `null` se ele não foi fechado. */
export async function currentRowsOf(tx: Reader, seasonId: number, period: Period, periodKey: string): Promise<Map<number, StoredRow> | null> {
  const head = await currentSnapshot(tx, seasonId, period, periodKey);
  if (!head) return null;
  return new Map((await rowsOfSnapshot(tx, head.id)).map((r) => [r.walletId, r]));
}

const CHUNK = 1000;

/** Grava uma versão do ranking com as linhas, em blocos. Devolve `false` se a versão já existe (outro processo fechou antes). */
export async function writeSnapshot(
  tx: Tx,
  head: { seasonId: number; period: Period; periodKey: string; closedAt: Date; botsIncluded: boolean; version: number; reason: string | null; createdAt: Date },
  rows: readonly StoredRow[],
): Promise<boolean> {
  const [snap] = await tx.db.insert(rankingSnapshots).values(head).onConflictDoNothing().returning({ id: rankingSnapshots.id });
  if (!snap) return false;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.db.insert(rankingRows).values(rows.slice(i, i + CHUNK).map((r) => ({ snapshotId: snap.id, ...r })));
  }
  return true;
}

/** Os rankings oficiais da temporada (versão atual de cada um), do fechamento mais antigo para o mais novo. */
export async function currentHeads(tx: Reader, seasonId: number): Promise<SnapshotHead[]> {
  const result = await tx.db.execute(sql`
    select distinct on (period, period_key) id, period, period_key, closed_at, bots_included, version
    from futbolsa.ranking_snapshots where season_id = ${seasonId}
    order by period, period_key, version desc`);
  return result.rows
    .map((r) => ({ id: Number(r.id), period: r.period as Period, periodKey: String(r.period_key), closedAt: new Date(r.closed_at as string), botsIncluded: Boolean(r.bots_included), version: Number(r.version) }))
    .sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime() || (a.period === "month" ? -1 : 1));
}
