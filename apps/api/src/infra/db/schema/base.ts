import { sql, type SQL } from "drizzle-orm";
import { bigint, pgSchema, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * As tabelas do jogo ficam no esquema próprio `futbolsa`, e não no `public`, que o
 * Supabase expõe pela API de dados dele com a chave pública do front (decisão do
 * Thaian em 2026-10-31, Plano do banco).
 */
export const futbolsa = pgSchema("futbolsa");

/** Dinheiro em centavos inteiros, `bigint` lido como `number` (2^53 centavos é folga). */
export const money = (name: string) => bigint(name, { mode: "number" });

/** Contadores e ids que crescem muito. */
export const bigId = (name: string) => bigint(name, { mode: "number" });

/** Instante em UTC (`timestamptz`). */
export const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** `CHECK (coluna IN (...))` com a lista de valores aceitos. */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}
