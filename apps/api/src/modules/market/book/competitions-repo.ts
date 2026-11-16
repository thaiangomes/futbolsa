import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { CompetitionMatch, CompetitionStage, CompetitionTie, CompetitionView, StandingRow } from "@futbolsa/contracts";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";
import { clubs, matches, seasonClubs, standings } from "../../../infra/db/schema/index.js";

type Db = Database | DrizzleTx;

/** A ordem das fases de uma copa na tela (a fase de grupos e as eliminatórias; uma fase que não está aqui vai por último). */
const PHASE_ORDER = ["grupos", "playoffs", "1a-fase", "2a-fase", "3a-fase", "4a-fase", "5a-fase", "oitavas", "quartas", "semifinal", "final"];
const phaseIndex = (p: string | null) => {
  const i = p === null ? -1 : PHASE_ORDER.indexOf(p);
  return i < 0 ? PHASE_ORDER.length : i;
};

/** A classificação e os jogos de uma competição na temporada (item 11). */
export async function competitionView(db: Db, seasonId: number, competition: CompetitionView["competition"], now: Date): Promise<CompetitionView> {
  const listed = new Map(
    (await db.select({ id: seasonClubs.clubId, ticker: clubs.ticker }).from(seasonClubs).innerJoin(clubs, eq(clubs.id, seasonClubs.clubId)).where(eq(seasonClubs.seasonId, seasonId))).map((r) => [r.id, r.ticker]),
  );
  const home = alias(clubs, "home");
  const away = alias(clubs, "away");
  const rows = await db
    .select({
      round: matches.round,
      phase: matches.phase,
      kickoff: matches.kickoff,
      status: matches.status,
      homeId: matches.homeClubId,
      awayId: matches.awayClubId,
      homeName: home.name,
      awayName: away.name,
      homeGoals: matches.homeGoals,
      awayGoals: matches.awayGoals,
      advancedId: matches.advancedClubId,
    })
    .from(matches)
    .innerJoin(home, eq(home.id, matches.homeClubId))
    .innerJoin(away, eq(away.id, matches.awayClubId))
    .where(and(eq(matches.seasonId, seasonId), eq(matches.competition, competition)))
    .orderBy(asc(matches.kickoff), asc(matches.id));

  const club = (id: number, name: string) => ({ ticker: listed.get(id) ?? null, name });
  const view = (r: (typeof rows)[number]): CompetitionMatch => ({
    kickoff: new Date(r.kickoff).toISOString(),
    status: r.status as CompetitionMatch["status"],
    home: club(r.homeId, r.homeName),
    away: club(r.awayId, r.awayName),
    homeGoals: r.homeGoals,
    awayGoals: r.awayGoals,
    advanced: r.advancedId === null ? null : r.advancedId === r.homeId ? "home" : r.advancedId === r.awayId ? "away" : null,
    inPlay: r.status === "scheduled" && new Date(r.kickoff).getTime() <= now.getTime(),
  });

  const isLeague = competition === "brasileirao-a" || competition === "brasileirao-b";
  // rodadas (campeonatos) ou fases (copas), cada uma com os jogos do mais cedo ao mais tarde
  const stages = new Map<string, CompetitionStage>();
  const tieRows = new Map<string, Array<(typeof rows)[number]>>();
  for (const r of rows) {
    const key = r.round !== null ? `r${r.round}` : `p${r.phase ?? ""}`;
    let stage = stages.get(key);
    if (!stage) stages.set(key, (stage = { round: r.round, phase: r.round === null ? r.phase : null, matches: [], ties: [] }));
    stage.matches.push(view(r));
    // nas copas, os jogos entre os mesmos dois clubes na mesma fase são um confronto (ida e volta)
    if (!isLeague) {
      const tieKey = `${key}|${Math.min(r.homeId, r.awayId)}|${Math.max(r.homeId, r.awayId)}`;
      tieRows.set(tieKey, [...(tieRows.get(tieKey) ?? []), r]);
      if (tieRows.get(tieKey)!.length === 1) stage.ties.push(null as never); // guarda o lugar do confronto, pelo primeiro jogo
    }
  }
  for (const [key, legs] of tieRows) {
    const stageKey = key.split("|")[0]!;
    const stage = stages.get(stageKey)!;
    const slot = stage.ties.findIndex((t) => t === null);
    stage.ties[slot] = tieOf(legs, club, view);
  }
  const ordered = [...stages.values()].sort((a, b) => (a.round !== null && b.round !== null ? a.round - b.round : phaseIndex(a.phase) - phaseIndex(b.phase)));

  const table = await db
    .select({ clubId: standings.clubId, name: clubs.name, position: standings.position, points: standings.points })
    .from(standings)
    .innerJoin(clubs, eq(clubs.id, standings.clubId))
    .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition)))
    .orderBy(asc(standings.position), asc(clubs.name));
  const empty = () => ({ played: 0, wins: 0, draws: 0, losses: 0, goalDiff: 0 });
  const stat = new Map<number, ReturnType<typeof empty>>();
  const tally = (id: number, own: number, other: number) => {
    const s = stat.get(id) ?? empty();
    s.played += 1;
    if (own > other) s.wins += 1;
    else if (own === other) s.draws += 1;
    else s.losses += 1;
    s.goalDiff += own - other;
    stat.set(id, s);
  };
  for (const r of rows) {
    if (r.status !== "finished" || r.homeGoals === null || r.awayGoals === null) continue;
    tally(r.homeId, r.homeGoals, r.awayGoals);
    tally(r.awayId, r.awayGoals, r.homeGoals);
  }
  const standingRows: StandingRow[] = isLeague
    ? table.map((t) => ({ position: t.position, club: club(t.clubId, t.name), points: t.points, ...(stat.get(t.clubId) ?? empty()) }))
    : [];
  return { competition, standings: standingRows, stages: ordered };
}

type Row = { homeId: number; awayId: number; homeName: string; awayName: string; homeGoals: number | null; awayGoals: number | null; status: string; advancedId: number | null; kickoff: Date };

/** Um confronto de copa a partir dos jogos entre os dois clubes na fase (já em ordem de horário). */
function tieOf(legs: Row[], club: (id: number, name: string) => { ticker: string | null; name: string }, view: (r: never) => CompetitionMatch): CompetitionTie {
  const first = legs[0]!;
  const home = club(first.homeId, first.homeName);
  const away = club(first.awayId, first.awayName);
  const done = legs.every((l) => l.status === "finished" && l.homeGoals !== null && l.awayGoals !== null);
  const aggregate = done
    ? legs.reduce((a, l) => (l.homeId === first.homeId ? { home: a.home + l.homeGoals!, away: a.away + l.awayGoals! } : { home: a.home + l.awayGoals!, away: a.away + l.homeGoals! }), { home: 0, away: 0 })
    : null;
  // quem passou: o que a fonte marcou (no jogo que decidiu) ou, sem marca, quem fez mais gols no agregado
  const marked = [...legs].reverse().find((l) => l.advancedId !== null)?.advancedId ?? null;
  const advanced: "home" | "away" | null = marked !== null ? (marked === first.homeId ? "home" : "away") : aggregate && aggregate.home !== aggregate.away ? (aggregate.home > aggregate.away ? "home" : "away") : null;
  return {
    home,
    away,
    legs: legs.map((l, i) => ({ leg: legs.length === 1 ? "unico" : i === 0 ? "ida" : "volta", match: view(l as never) })),
    aggregate,
    advanced,
    penalties: aggregate !== null && aggregate.home === aggregate.away && advanced !== null,
  };
}
