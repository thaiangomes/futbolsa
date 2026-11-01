import { randomBytes } from "node:crypto";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../src/infra/db/migrate.js";
import { adminQuery, testDatabaseUrl, withDatabase } from "./db.js";

/**
 * Antes de todos os testes: cria um banco modelo com as migrações aplicadas. O nome
 * é único por execução, para duas execuções (de sessões diferentes) não brigarem.
 */
export default async function setup(project: TestProject) {
  const url = testDatabaseUrl();
  const template = `futbolsa_tpl_${process.pid}_${randomBytes(3).toString("hex")}`;
  try {
    await adminQuery("select 1");
  } catch (error) {
    throw new Error(
      `Postgres de teste fora do ar (${new URL(url).host}). Aponte TEST_DATABASE_URL para um Postgres ` +
        `ou suba o do Docker: docker compose up -d postgres-test`,
      { cause: error },
    );
  }
  await adminQuery(`create database "${template}"`);
  await runMigrations(withDatabase(url, template));
  project.provide("templateDatabase", template);

  return async () => {
    await adminQuery(`drop database if exists "${template}" with (force)`);
  };
}
