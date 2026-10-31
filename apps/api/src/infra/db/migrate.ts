import { fileURLToPath, pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connect } from "./client.js";

/** `apps/api/drizzle/`, igual a partir de `src/infra/db` e de `dist/infra/db`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/** Aplica as migrações que faltam. Rodar de novo não faz nada. */
export async function runMigrations(url: string): Promise<void> {
  const conn = connect(url, 1);
  try {
    await migrate(conn.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await conn.close();
  }
}

// `npm run db:migrate` e o contêiner da API, antes de subir.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL não definida (veja .env.example).");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("Migrações aplicadas.");
}
