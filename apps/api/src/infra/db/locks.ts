import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { clubs, payoutEvents, seasonClubs, seasons, wallets } from "./schema/index.js";
import { metrics, type LockKind } from "./metrics.js";
import type { Tx } from "./transaction.js";

/** Mede a espera de uma instrução de trava (só com medidores ligados) e deixa o instante da aquisição para o `COMMIT`. */
async function timed<T>(tx: Tx, kind: LockKind, key: string | undefined, run: () => Promise<T>): Promise<T> {
  const m = metrics();
  if (!m.enabled) return run();
  const start = performance.now();
  const result = await run();
  const end = performance.now();
  m.lockWait(kind, key, end - start);
  tx.noteLock(kind, key, end);
  return result;
}

/**
 * As travas de linha, sempre na mesma ordem em todo o jogo: a temporada; os
 * clubes por ticker; os eventos de pagamento por id (P3 da F12); as carteiras de
 * jogadores e bots por id; a tesouraria por último (Arquitetura da Fase 1,
 * decisão 4). Cada função ordena o que recebe e recusa, com `LockOrderError`, uma
 * trava que viria antes de outra já tomada.
 */

export type SeasonRow = typeof seasons.$inferSelect;
export type LockedClub = typeof seasonClubs.$inferSelect & { ticker: string };
export type WalletRow = typeof wallets.$inferSelect;
export type PayoutEventRow = typeof payoutEvents.$inferSelect;

/**
 * `share` na oferta do IPO; `update` para fechar o IPO, encerrar a negociação ou a temporada.
 *
 * O modo exclusivo é `FOR NO KEY UPDATE`, e não `FOR UPDATE`. Os dois excluem outra trava exclusiva e a
 * compartilhada (`FOR SHARE`), que é o que o jogo precisa; a diferença é que o `FOR UPDATE` segura também a checagem
 * de chave estrangeira (`FOR KEY SHARE`) de quem grava uma linha que aponta para a temporada. A ordem nova trava o
 * clube sem travar a temporada (decisão 4 da arquitetura) e depois grava em `orders` e `trades`, que apontam para
 * ela: com `FOR UPDATE`, quem tivesse a temporada e esperasse o clube (a suspensão do mercado todo, o fim da
 * negociação) fecharia um círculo com a ordem em andamento, e o Postgres abortaria uma das duas por *deadlock*.
 * Ninguém muda a chave nem apaga a linha da temporada, então a trava mais fraca basta.
 */
export async function lockSeason(tx: Tx, seasonId: number, mode: "share" | "update"): Promise<SeasonRow> {
  tx.locks.checkSeason(seasonId, mode);
  const rows = await timed(tx, "season", undefined, () =>
    tx.db
      .select()
      .from(seasons)
      .where(eq(seasons.id, seasonId))
      .for(mode === "update" ? "no key update" : "share"),
  );
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
  const rows = await timed(tx, "club", sorted.join(","), () =>
    tx.db
      .select({ ...getTableColumns(sc), ticker: clubs.ticker })
      .from(sc)
      .innerJoin(clubs, eq(clubs.id, sc.clubId))
      .where(and(eq(sc.seasonId, seasonId), inArray(clubs.ticker, sorted)))
      // ordem binária, a mesma da comparação de strings do JavaScript
      .orderBy(sql`${clubs.ticker} collate "C"`)
      .for("update", { of: sc }),
  );
  if (rows.length !== sorted.length) {
    const found = new Set(rows.map((r) => r.ticker));
    const missing = sorted.filter((t) => !found.has(t));
    throw new Error(`clube não listado na temporada ${seasonId}: ${missing.join(", ")}`);
  }
  tx.locks.markClubs(seasonId, sorted);
  return rows as LockedClub[];
}

/**
 * Trava as linhas dos eventos de pagamento em ordem de id, depois dos clubes e antes das carteiras (P3 da F12),
 * e as devolve nessa ordem. `share` (`FOR SHARE`) num lote de crédito: vários lotes do mesmo evento andam juntos,
 * e quem quer mudar o evento (a correção, com `update`) espera o lote acabar, para o estorno não ser calculado
 * sobre um pagamento pela metade.
 */
export async function lockPayoutEvents(tx: Tx, ids: readonly number[], mode: "share" | "update"): Promise<PayoutEventRow[]> {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  tx.locks.checkPayoutEvents(sorted, mode);
  const rows = await timed(tx, "payout_event", undefined, () =>
    tx.db
      .select()
      .from(payoutEvents)
      .where(inArray(payoutEvents.id, sorted))
      .orderBy(asc(payoutEvents.id))
      .for(mode),
  );
  if (rows.length !== sorted.length) {
    const found = new Set(rows.map((r) => r.id));
    throw new Error(`evento de pagamento inexistente: ${sorted.filter((id) => !found.has(id)).join(", ")}`);
  }
  tx.locks.markPayoutEvents(sorted, mode);
  return rows;
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
  const withTreasury = keys.some(([treasury]) => treasury === 1);
  const rows = await timed(tx, withTreasury ? "wallet_treasury" : "wallet", undefined, () =>
    tx.db
      .select()
      .from(wallets)
      .where(inArray(wallets.id, unique))
      .orderBy(sql`${wallets.ownerType} = 'treasury'`, asc(wallets.id))
      .for("update"),
  );
  tx.locks.markWallets(keys);
  return rows;
}
