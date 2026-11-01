import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DbConnection {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Tamanho padrão do conjunto fixo de conexões (Arquitetura da Fase 1, Escala). */
export const DEFAULT_POOL_SIZE = 20;

/**
 * Abre um conjunto fixo de conexões. As operações esperam a vez na fila do `pg`
 * em vez de abrir conexão nova. O pool só conecta na primeira consulta.
 */
export function connect(url: string, poolSize = Number(process.env.DB_POOL_SIZE ?? DEFAULT_POOL_SIZE)): DbConnection {
  const pool = new pg.Pool({ connectionString: url, max: poolSize });
  // Uma conexão ociosa que cai (banco reiniciado, rede) emite "error" no pool; sem quem
  // escute, o Node derruba o processo. O pool descarta a conexão e abre outra na próxima consulta.
  pool.on("error", (error) => console.error(`conexão ociosa do banco caiu: ${error.message}`));
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
