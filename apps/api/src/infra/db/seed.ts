import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { CLUBS } from "@futbolsa/engine/data/clubs";
import { badgeColumns } from "./club-badge.js";
import { connect, type Database } from "./client.js";
import { clubs, seasons } from "./schema/index.js";

/** Ano da temporada criada pelo seed quando `--year` não vem (proposta do Plano do banco). */
export const DEFAULT_SEED_YEAR = 2027;

/**
 * Dados iniciais: os clubes de `src/data/clubs.ts` com ticker e nome, e a temporada
 * em preparação com os padrões do formador. Rodar de novo não muda nada. Os valores
 * e as tabelas das copas são copiados pelo `dividends` ao preparar a temporada, e os
 * bots são criados pelo admin.
 */
export async function seed(db: Database, year = DEFAULT_SEED_YEAR): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(clubs)
      .values(CLUBS.map((c) => ({ ticker: c.id, name: c.name, ...badgeColumns(c.id) })))
      .onConflictDoNothing({ target: clubs.ticker });
    await tx.insert(seasons).values({ year }).onConflictDoNothing({ target: seasons.year });
  });
}

// `npm run db:seed -- --year 2027`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { year: { type: "string" } } });
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL não definida (veja .env.example).");
    process.exit(1);
  }
  const year = values.year ? Number(values.year) : DEFAULT_SEED_YEAR;
  if (!Number.isInteger(year)) {
    console.error(`--year inválido: ${values.year}`);
    process.exit(1);
  }
  const conn = connect(url, 1);
  try {
    await seed(conn.db, year);
    console.log(`Seed aplicado: ${CLUBS.length} clubes e a temporada ${year} em preparação.`);
  } finally {
    await conn.close();
  }
}
