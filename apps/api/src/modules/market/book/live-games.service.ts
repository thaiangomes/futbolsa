import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { LiveGames } from "@futbolsa/contracts";
import { dayStart, nextDayStart } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs, matches, seasonClubs } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { changeBp, displayedPriceOf, displayedPrices } from "../state/displayed-price.js";
import { classifyGames, LIVE_WINDOW_MS, type GameRow, type PriceInfo } from "./live-games.js";
import { LiveScores } from "./live-scores.js";

const homeClub = alias(clubs, "home_club");
const awayClub = alias(clubs, "away_club");

const gameColumns = {
  competition: matches.competition,
  round: matches.round,
  phase: matches.phase,
  kickoff: matches.kickoff,
  status: matches.status,
  homeGoals: matches.homeGoals,
  awayGoals: matches.awayGoals,
  homeTicker: homeClub.ticker,
  homeName: homeClub.name,
  awayTicker: awayClub.ticker,
  awayName: awayClub.name,
};

type Row = {
  competition: string;
  round: number | null;
  phase: string | null;
  kickoff: Date;
  status: string;
  homeGoals: number | null;
  awayGoals: number | null;
  homeTicker: string | null;
  homeName: string;
  awayTicker: string | null;
  awayName: string;
};

const toRow = (r: Row): GameRow => ({
  competition: r.competition,
  round: r.round,
  phase: r.phase,
  kickoff: r.kickoff,
  status: r.status,
  homeGoals: r.homeGoals,
  awayGoals: r.awayGoals,
  home: { ticker: r.homeTicker, name: r.homeName },
  away: { ticker: r.awayTicker, name: r.awayName },
});

/**
 * `GET /live-games` (item 25 da fila da partida de teste): os jogos em andamento, os de mais tarde hoje, os encerrados hoje e
 * o próximo jogo, cada time com o preço e a variação do dia. Só leitura, sem trava, pública. O placar parcial vem da fonte
 * de placares (`LiveScores`); a regra de quem está "em andamento" fica em `classifyGames`.
 */
@Injectable()
export class LiveGamesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly scores: LiveScores,
  ) {}

  async read(): Promise<LiveGames> {
    const now = this.clock.now();
    const season = await currentSeason(this.db);
    if (!season) return { live: [], upcoming: [], finished: [], next: null };
    const start = new Date(dayStart(now.getTime()));
    const end = new Date(nextDayStart(now.getTime()));
    const from = new Date(Math.min(start.getTime(), now.getTime() - LIVE_WINDOW_MS));

    const select = () =>
      this.db
        .select(gameColumns)
        .from(matches)
        .innerJoin(homeClub, eq(homeClub.id, matches.homeClubId))
        .innerJoin(awayClub, eq(awayClub.id, matches.awayClubId));
    const today = (await select().where(and(eq(matches.seasonId, season.id), inArray(matches.status, ["scheduled", "finished"]), gte(matches.kickoff, from), lt(matches.kickoff, end)))) as Row[];
    const [next] = (await select()
      .where(and(eq(matches.seasonId, season.id), eq(matches.status, "scheduled"), gt(matches.kickoff, now)))
      .orderBy(asc(matches.kickoff), asc(matches.id))
      .limit(1)) as Row[];

    // o preço de hoje e o das 0h, como a lista do Mercado
    const listed = await this.db
      .select({ ticker: clubs.ticker, lastPrice: seasonClubs.lastPrice, ipoPrice: seasonClubs.ipoPrice })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, season.id));
    const opens = await displayedPrices(this.db, season.id, start);
    const prices = new Map<string, PriceInfo>();
    for (const c of listed) {
      if (!c.ticker) continue;
      const price = displayedPriceOf(c);
      prices.set(c.ticker, { price, changeBp: changeBp(price, opens.get(c.ticker) ?? price) });
    }

    const view = classifyGames(today.map(toRow), { now, dayStart: start, nextDayStart: end, prices, partials: this.scores.at(now) });
    const nextGame = next ? classifyGames([toRow(next)], { now: new Date(next.kickoff.getTime() - 1), dayStart: new Date(0), nextDayStart: new Date(8.64e15), prices, partials: [] }).upcoming[0] : undefined;
    return { ...view, next: nextGame ?? null };
  }
}
