import { and, eq, isNotNull } from "drizzle-orm";
import type { AuctionState } from "@futbolsa/contracts";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";
import { clubs, seasonClubs } from "../../../infra/db/schema/index.js";

type Db = Database | DrizzleTx;

/**
 * O estado do leilão de um clube como o jogador o vê (P11): `null` fora de leilão; `{ until }` com a hora do fim
 * enquanto ele corre; `{ until: null }` enquanto está parado pela suspensão (a linha tem o início e não tem o fim).
 */
export function auctionStateOf(club: { auctionOpenedAt: Date | null; auctionUntil: Date | null }): AuctionState | null {
  if (club.auctionOpenedAt === null) return null;
  return { until: club.auctionUntil ? club.auctionUntil.toISOString() : null };
}

/** Os clubes da temporada que estão em leilão agora (aberto ou parado), por ticker. Para a carteira e a lista. */
export async function auctionStates(db: Db, seasonId: number): Promise<Map<string, AuctionState>> {
  const rows = await db
    .select({ ticker: clubs.ticker, auctionOpenedAt: seasonClubs.auctionOpenedAt, auctionUntil: seasonClubs.auctionUntil })
    .from(seasonClubs)
    .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
    .where(and(eq(seasonClubs.seasonId, seasonId), isNotNull(seasonClubs.auctionOpenedAt)));
  return new Map(rows.map((r) => [r.ticker!, auctionStateOf(r)!]));
}
