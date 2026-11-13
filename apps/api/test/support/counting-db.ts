import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type { Database } from "../../src/infra/db/client.js";
import * as schema from "../../src/infra/db/schema/index.js";

/**
 * Um `Database` que anota cada comando SQL que passa por ele (o `logger` do Drizzle), no mesmo
 * pool do banco de teste. Para medir quantos comandos uma operação manda: marque um ponto com
 * `mark()` e leia o que veio depois com `since(marca)`, ou use `countStatements`.
 *
 * Só conta o que passa por este `db` (as transações abertas nele inclusive, com `begin` e
 * `commit`); outro `Database` no mesmo pool não aparece.
 */
export interface CountingDatabase {
  readonly db: Database;
  /** Todos os comandos, em ordem. */
  readonly statements: readonly string[];
  /** Um ponto na lista, para `since`. */
  mark(): number;
  /** Os comandos depois da marca. */
  since(mark: number): string[];
}

export function countingDatabase(pool: pg.Pool): CountingDatabase {
  const statements: string[] = [];
  const db = drizzle(pool, { schema, logger: { logQuery: (query) => void statements.push(query) } }) as Database;
  return {
    db,
    statements,
    mark: () => statements.length,
    since: (mark) => statements.slice(mark),
  };
}

/** Roda `fn` e devolve o resultado e os comandos SQL que ela mandou por `counting`. */
export async function countStatements<T>(counting: CountingDatabase, fn: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
  const mark = counting.mark();
  const result = await fn();
  return { result, statements: counting.since(mark) };
}

/** Só as escritas (`insert`, `update`, `delete`) de uma lista de comandos. */
export const writesIn = (statements: readonly string[]) => statements.filter((s) => /^\s*(insert|update|delete)\b/i.test(s));
