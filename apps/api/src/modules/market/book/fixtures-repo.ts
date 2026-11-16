import { sql } from "drizzle-orm";
import type { Fixture } from "@futbolsa/contracts";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";

type Db = Database | DrizzleTx;

interface Row {
  club_id: number;
  kickoff: Date;
  competition: Fixture["competition"];
  round: number | null;
  phase: string | null;
  home: boolean;
  opp_ticker: string | null;
  opp_name: string;
}

const toFixture = (r: Row, now: Date): Fixture => ({
  kickoff: new Date(r.kickoff).toISOString(),
  competition: r.competition,
  round: r.round,
  phase: r.phase,
  home: r.home,
  opponent: { ticker: r.opp_ticker, name: r.opp_name },
  // o jogo já passou do horário e continua agendado: o placar ainda não chegou ("em jogo agora", como o modo de jogo da casa)
  inPlay: new Date(r.kickoff).getTime() <= now.getTime(),
});

/** Os jogos agendados de cada clube, um por linha, do ponto de vista do clube (mando e adversário). */
const SIDES = (seasonId: number) => sql`
  select m.home_club_id as club_id, m.away_club_id as opp_id, true as home, m.kickoff, m.competition, m.round, m.phase
  from futbolsa.matches m where m.season_id = ${seasonId} and m.status = 'scheduled'
  union all
  select m.away_club_id, m.home_club_id, false, m.kickoff, m.competition, m.round, m.phase
  from futbolsa.matches m where m.season_id = ${seasonId} and m.status = 'scheduled'`;

/** O próximo jogo agendado de cada clube (em qualquer competição), por id do clube. */
export async function nextFixtures(db: Db, seasonId: number, now: Date): Promise<Map<number, Fixture>> {
  const res = await db.execute(sql`
    select distinct on (x.club_id) x.club_id, x.kickoff, x.competition, x.round, x.phase, x.home, o.ticker as opp_ticker, o.name as opp_name
    from (${SIDES(seasonId)}) x join futbolsa.clubs o on o.id = x.opp_id
    order by x.club_id, x.kickoff, x.competition`);
  return new Map((res.rows as unknown as Row[]).map((r) => [Number(r.club_id), toFixture(r, now)]));
}

/** Os próximos jogos agendados de um clube, do mais perto para o mais longe. */
export async function clubFixtures(db: Db, seasonId: number, clubId: number, now: Date, limit: number): Promise<Fixture[]> {
  const res = await db.execute(sql`
    select x.club_id, x.kickoff, x.competition, x.round, x.phase, x.home, o.ticker as opp_ticker, o.name as opp_name
    from (${SIDES(seasonId)}) x join futbolsa.clubs o on o.id = x.opp_id
    where x.club_id = ${clubId}
    order by x.kickoff, x.competition
    limit ${limit}`);
  return (res.rows as unknown as Row[]).map((r) => toFixture(r, now));
}
