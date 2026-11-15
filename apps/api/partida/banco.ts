import pg from "pg";
import { sql } from "drizzle-orm";
import type { Database } from "../src/infra/db/index.js";
import { runMigrations } from "../src/infra/db/migrate.js";
import { recusarBancoNaoLocalEstrito } from "./guardas.js";

/**
 * O banco persistente da partida (`futbolsa_partida`, no Postgres da máquina, nunca no Docker): criado na primeira subida,
 * com as migrações de verdade, e mantido entre as subidas. As duas tabelas da partida (`partida_estado` e `partida_dados`)
 * são criadas aqui, fora das migrações do jogo: nada disso existe na instalação de produção.
 */
export const NOME_DO_BANCO = "futbolsa_partida";

export interface BancoDaPartida {
  url: string;
  /** O banco acabou de ser criado nesta subida. */
  criado: boolean;
}

function comBanco(url: string, nome: string): string {
  const u = new URL(url);
  u.pathname = `/${nome}`;
  return u.toString();
}

async function comAdmin<T>(urlBase: string, run: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlBase });
  await c.connect();
  try {
    return await run(c);
  } finally {
    await c.end();
  }
}

/** Só bancos `futbolsa_partida` (ou `futbolsa_partida_<sufixo>`, dos testes): a partida nunca mexe num banco de outro nome. */
function conferirNome(nome: string): string {
  if (!/^futbolsa_partida(_[a-z0-9_]+)?$/.test(nome)) throw new Error(`nome de banco da partida inválido: ${nome}`);
  return nome;
}

export async function prepararBanco(urlBase: string, nomeDoBanco = NOME_DO_BANCO): Promise<BancoDaPartida> {
  recusarBancoNaoLocalEstrito(urlBase);
  const NOME = conferirNome(nomeDoBanco);
  const existe = await comAdmin(urlBase, async (c) => {
    const r = await c.query("select 1 from pg_database where datname = $1", [NOME]);
    if (r.rowCount === 0) await c.query(`create database "${NOME}"`);
    return (r.rowCount ?? 0) > 0;
  });
  const url = comBanco(urlBase, NOME);
  await runMigrations(url);
  return { url, criado: !existe };
}

/** Zerar a partida (só pelo terminal): apaga o banco `futbolsa_partida` e nenhum outro. */
export async function apagarBanco(urlBase: string, nomeDoBanco = NOME_DO_BANCO): Promise<void> {
  recusarBancoNaoLocalEstrito(urlBase);
  await comAdmin(urlBase, (c) => c.query(`drop database if exists "${conferirNome(nomeDoBanco)}" with (force)`));
}

/** As tabelas da partida (criadas só se faltarem). */
export async function criarTabelasDaPartida(db: Database): Promise<void> {
  await db.execute(sql`
    create table if not exists public.partida_estado (
      id integer primary key check (id = 1),
      instante timestamptz not null,
      ano integer not null,
      atualizado_em timestamptz not null default now()
    )`);
  await db.execute(sql`
    create table if not exists public.partida_dados (
      id serial primary key,
      competicao text not null,
      baixado_em timestamptz not null default now(),
      dados jsonb not null
    )`);
}
