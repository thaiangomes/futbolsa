import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, inject } from "vitest";
import { connect, type Database, type DbConnection } from "../../src/infra/db/client.js";

/**
 * O servidor Postgres dos testes, por `TEST_DATABASE_URL`: um Postgres instalado na
 * máquina (sem o nome do banco, entra no banco do usuário) ou o do `docker-compose.yml`,
 * que é o padrão (o mesmo valor do `.env.example`). Os testes só criam e apagam bancos
 * próprios, com nome único, nesse servidor.
 */
export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? "postgres://futbolsa:futbolsa@localhost:5433/futbolsa_test";
}

/** A mesma URL apontando para outro banco do mesmo servidor. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Roda um comando de administração (criar e apagar bancos) no banco principal de teste. */
export async function adminQuery(sql: string): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

export interface TestDatabase extends DbConnection {
  name: string;
  url: string;
}

/**
 * Cria um banco novo, cópia do modelo já migrado pelo `globalSetup`
 * (`CREATE DATABASE … TEMPLATE`, décimos de segundo). Cada arquivo de teste usa o
 * seu, então os arquivos rodam em paralelo sem um ver o outro.
 */
export async function createTestDatabase(poolSize = 30): Promise<TestDatabase> {
  const template = inject("templateDatabase");
  const name = `futbolsa_t_${process.pid}_${randomBytes(4).toString("hex")}`;
  await adminQuery(`create database "${name}" template "${template}"`);
  const url = withDatabase(testDatabaseUrl(), name);
  const conn = connect(url, poolSize);
  return {
    ...conn,
    name,
    url,
    async close() {
      await conn.close();
      await adminQuery(`drop database if exists "${name}" with (force)`);
    },
  };
}

/** Um banco para o arquivo de teste inteiro: criado antes e apagado depois. */
export function useTestDatabase(poolSize?: number): { readonly db: Database; readonly conn: TestDatabase } {
  let conn: TestDatabase | undefined;
  beforeAll(async () => {
    conn = await createTestDatabase(poolSize);
  });
  afterAll(async () => {
    await conn?.close();
  });
  return {
    get db() {
      return conn!.db;
    },
    get conn() {
      return conn!;
    },
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}
