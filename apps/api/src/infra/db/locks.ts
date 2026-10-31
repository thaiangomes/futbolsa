import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { clubs, seasonClubs, seasons, wallets } from "./schema/index.js";
import type { Tx } from "./transaction.js";

/**
 * As travas de linha, sempre na mesma ordem em todo o jogo: a temporada; os
 * clubes por ticker; as carteiras de jogadores e bots por id; a tesouraria por
 * último (Arquitetura da Fase 1, decisão 4). Cada função ordena o que recebe e
 * recusa, com `LockOrderError`, uma trava que viria antes de outra já tomada.
 */

export type SeasonRow = typeof seasons.$inferSelect;
export type LockedClub = typeof seasonClubs.$inferSelect & { ticker: string };
export type WalletRow = typeof wallets.$inferSelect;

/** `share` na oferta do IPO; `update` para fechar o IPO, encerrar a negociação ou a temporada. */
export async function lockSeason(tx: Tx, seasonId: number, mode: "share" | "update"): Promise<SeasonRow> {
  tx.locks.checkSeason(seasonId, mode);
  const rows = await tx.db.select().from(seasons).where(eq(seasons.id, seasonId)).for(mode);
  if (rows.length === 0) throw new Error(`temporada inexistente: ${seasonId}`);
  tx.locks.markSeason(seasonId, mode);
  return rows[0]!;
}

/**
 * Trava as linhas de `season_clubs` dos tickers, em ordem de ticker, e as devolve
 * nessa ordem (com o `last_price`, que o limite de 20% usa sem outra consulta).
 */
export async function lockClubs(tx: Tx, seasonId: number, tickers: readonly string[]): Promise<LockedClub[]> {
  const sorted = [...new Set(tickers)].sort();
  if (sorted.length === 0) return [];
  tx.locks.checkClubs(seasonId, sorted);
  // o `FOR UPDATE OF` só aceita o nome sem o esquema: daí o apelido
  const sc = alias(seasonClubs, "sc");
  const rows = await tx.db
    .select({ ...getTableColumns(sc), ticker: clubs.ticker })
    .from(sc)
    .innerJoin(clubs, eq(clubs.id, sc.clubId))
    .where(and(eq(sc.seasonId, seasonId), inArray(clubs.ticker, sorted)))
    // ordem binária, a mesma da comparação de strings do JavaScript
    .orderBy(sql`${clubs.ticker} collate "C"`)
    .for("update", { of: sc });
  if (rows.length !== sorted.length) {
    const found = new Set(rows.map((r) => r.ticker));
    const missing = sorted.filter((t) => !found.has(t));
    throw new Error(`clube não listado na temporada ${seasonId}: ${missing.join(", ")}`);
  }
  tx.locks.markClubs(seasonId, sorted);
  return rows as LockedClub[];
}

/**
 * Trava as carteiras em ordem de id, com a tesouraria por último, e as devolve nessa
 * ordem. Lê antes quem é tesouraria (o dono de uma carteira nunca muda).
 */
export async function lockWallets(tx: Tx, ids: readonly number[]): Promise<WalletRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const owners = await tx.db
    .select({ id: wallets.id, ownerType: wallets.ownerType })
    .from(wallets)
    .where(inArray(wallets.id, unique));
  if (owners.length !== unique.length) {
    const found = new Set(owners.map((o) => o.id));
    throw new Error(`carteira inexistente: ${unique.filter((id) => !found.has(id)).join(", ")}`);
  }
  const keys = owners
    .map((o) => [o.ownerType === "treasury" ? 1 : 0, o.id] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  tx.locks.checkWallets(keys);
  const rows = await tx.db
    .select()
    .from(wallets)
    .where(inArray(wallets.id, unique))
    .orderBy(sql`${wallets.ownerType} = 'treasury'`, asc(wallets.id))
    .for("update");
  tx.locks.markWallets(keys);
  return rows;
}
