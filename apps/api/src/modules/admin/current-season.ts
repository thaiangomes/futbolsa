import { desc, ne } from "drizzle-orm";
import type { Database, DrizzleTx } from "../../infra/db/index.js";
import { seasons } from "../../infra/db/schema/index.js";

export type SeasonRow = typeof seasons.$inferSelect;

/** A temporada atual: a mais nova que não está encerrada (só há uma por vez fora de `closed`). */
export async function currentSeason(db: Database | DrizzleTx): Promise<SeasonRow | null> {
  const [season] = await db.select().from(seasons).where(ne(seasons.status, "closed")).orderBy(desc(seasons.year)).limit(1);
  return season ?? null;
}
