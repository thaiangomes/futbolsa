import { randomBytes } from "node:crypto";
import pg from "pg";
import { runMigrations } from "../src/infra/db/migrate.js";
import { recusarBancoNaoLocal } from "./guardas.js";

/**
 * O banco próprio de cada execução do ensaio (`futbolsa_ensaio_<data>_<sufixo>`), criado ao lado do banco de teste, com as migrações
 * de verdade, e apagado no fim (salvo `--manter`). Nunca toca num banco hospedado (guarda da P1).
 */
export interface BancoDoEnsaio {
  nome: string;
  url: string;
  apagar(): Promise<void>;
}

function comBanco(url: string, nome: string): string {
  const u = new URL(url);
  u.pathname = `/${nome}`;
  return u.toString();
}

export async function criarBancoDoEnsaio(urlBase: string): Promise<BancoDoEnsaio> {
  recusarBancoNaoLocal(urlBase);
  const data = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const nome = `futbolsa_ensaio_${data}_${randomBytes(3).toString("hex")}`;
  const admin = async (sql: string) => {
    const cliente = new pg.Client({ connectionString: urlBase });
    await cliente.connect();
    try {
      await cliente.query(sql);
    } finally {
      await cliente.end();
    }
  };
  await admin(`create database "${nome}"`);
  const url = comBanco(urlBase, nome);
  await runMigrations(url);
  return { nome, url, apagar: () => admin(`drop database if exists "${nome}" with (force)`) };
}
