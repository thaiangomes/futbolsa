import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { CompetitionCode, PendingResponse } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs, matches } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../current-season.js";
import { findPending, type PendingInput } from "./pending.js";

/** Calcula as pendências da temporada atual (Admin, critério 5). */
@Injectable()
export class PendingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async compute(): Promise<PendingResponse> {
    const season = await currentSeason(this.db);
    if (!season) return findPending([], this.clock.now());
    const home = alias(clubs, "home");
    const away = alias(clubs, "away");
    const rows = await this.db
      .select({ m: matches, homeTicker: home.ticker, homeName: home.name, awayTicker: away.ticker, awayName: away.name })
      .from(matches)
      .innerJoin(home, eq(home.id, matches.homeClubId))
      .innerJoin(away, eq(away.id, matches.awayClubId))
      .where(eq(matches.seasonId, season.id));
    const inputs: PendingInput[] = rows.map(({ m, homeTicker, homeName, awayTicker, awayName }) => ({
      id: m.id,
      competition: m.competition as CompetitionCode,
      round: m.round,
      phase: m.phase,
      homeTicker,
      homeName,
      awayTicker,
      awayName,
      kickoff: m.kickoff,
      finishedAt: m.finishedAt,
      status: m.status as PendingInput["status"],
      outOfWindow: m.outOfWindow,
      homeGoals: m.homeGoals,
      fetchedAt: (m.sourceSnapshot as { fetchedAt?: string } | null)?.fetchedAt ?? null,
    }));
    return findPending(inputs, this.clock.now());
  }
}
