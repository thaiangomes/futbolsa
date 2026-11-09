import { and, eq, lte, or } from "drizzle-orm";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";
import { matches } from "../../../infra/db/schema/index.js";

type Db = Database | DrizzleTx;

/**
 * O modo de jogo do formador (Livro de ofertas, "Jogos e fechamentos"): começa no horário marcado do início do
 * jogo do clube e só termina quando o placar daquele jogo é importado ou preenchido pelo admin (o jogo vira
 * `finished`), não num tempo fixo depois do início, porque até lá a casa não sabe o resultado. Jogo adiado ou
 * cancelado não liga o modo de jogo. Só os jogos com status `scheduled` e horário já passado contam.
 */
export function matchModeOf(clubMatches: readonly { kickoff: Date; status: string }[], now: Date): boolean {
  return clubMatches.some((m) => m.status === "scheduled" && m.kickoff.getTime() <= now.getTime());
}

/** Se o clube está no modo de jogo agora, lido dos jogos da temporada (sem trava). */
export async function inMatch(db: Db, seasonId: number, clubId: number, now: Date): Promise<boolean> {
  const rows = await db
    .select({ kickoff: matches.kickoff, status: matches.status })
    .from(matches)
    .where(
      and(
        eq(matches.seasonId, seasonId),
        eq(matches.status, "scheduled"),
        lte(matches.kickoff, now),
        or(eq(matches.homeClubId, clubId), eq(matches.awayClubId, clubId)),
      ),
    )
    .limit(1);
  return matchModeOf(rows, now);
}

/** Os ids dos clubes que estão no modo de jogo agora, de uma vez (a lista de clubes e a reposição usam). */
export async function clubsInMatch(db: Db, seasonId: number, now: Date, clubIds?: readonly number[]): Promise<number[]> {
  const rows = await db
    .select({ home: matches.homeClubId, away: matches.awayClubId })
    .from(matches)
    .where(and(eq(matches.seasonId, seasonId), eq(matches.status, "scheduled"), lte(matches.kickoff, now)));
  const ids = new Set(rows.flatMap((r) => [r.home, r.away]));
  const only = clubIds ? new Set(clubIds) : null;
  return [...ids].filter((id) => !only || only.has(id));
}

