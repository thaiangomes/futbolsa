import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { Cents, Match } from "@futbolsa/engine";
import { DB, type Database, type DrizzleTx, Tx } from "../../../infra/db/index.js";
import { clubs, matches, seasonClubs, seasonRules, standings } from "../../../infra/db/schema/index.js";
import { SeasonValuesService } from "../../dividends/season-values/season-values.service.js";
import { toEngineMatch } from "../../admin/results/to-engine.js";
import { fairValuesAt, type FairValueData } from "./fair-value.js";

const LEAGUES: readonly string[] = ["brasileirao-a", "brasileirao-b"];

/**
 * Monta o valor justo de cada clube a partir do banco (T9). Roda **fora** da trava do clube: lê jogos, classificação
 * e valores da temporada (que não mudam durante a negociação, a não ser por um placar novo, e este traz o pedido de
 * reposição que refaz a conta) e entrega a foto para a reposição usar depois de travar.
 */
@Injectable()
export class FairValueService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly values: SeasonValuesService,
  ) {}

  /** Os dados que o motor precisa, lidos do banco. */
  async load(seasonId: number, executor: Database | DrizzleTx = this.db): Promise<FairValueData> {
    const matchRows = await executor.select().from(matches).where(eq(matches.seasonId, seasonId)).orderBy(asc(matches.kickoff), asc(matches.id));
    const listedRows = await executor
      .select({ clubId: seasonClubs.clubId, ticker: clubs.ticker, division: seasonClubs.division })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, seasonId));
    const standingRows = await executor
      .select({ competition: standings.competition, clubId: standings.clubId, position: standings.position })
      .from(standings)
      .where(eq(standings.seasonId, seasonId))
      .orderBy(asc(standings.competition), asc(standings.position), asc(standings.clubId));

    const ids = new Set<number>(listedRows.map((r) => r.clubId));
    for (const m of matchRows) {
      ids.add(m.homeClubId);
      ids.add(m.awayClubId);
      if (m.advancedClubId !== null) ids.add(m.advancedClubId);
    }
    for (const s of standingRows) ids.add(s.clubId);
    const clubRows = await executor.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs);
    const engineId = new Map(clubRows.filter((c) => ids.has(c.id)).map((c) => [c.id, c.ticker ?? `EXT-${c.id}`]));
    const tickerOf = (id: number) => {
      const t = engineId.get(id);
      if (t === undefined) throw new Error(`clube ${id} fora da temporada ${seasonId}`);
      return t;
    };

    const official: Record<string, string[]> = {};
    for (const s of standingRows) {
      if (LEAGUES.includes(s.competition)) (official[s.competition] ??= []).push(tickerOf(s.clubId));
    }
    const [rules] = await executor.select({ bp: seasonRules.buybackMultipleBp }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    if (!rules) throw new Error(`temporada sem valores: ${seasonId}`);
    // `loadSeasonValues` recebe um `Tx`; fora de transação, um `Tx` em volta do banco serve, porque só lê
    const values = await this.values.loadSeasonValues(new Tx(executor as DrizzleTx), seasonId);

    return {
      matches: matchRows.map((m): Match => toEngineMatch(m, tickerOf)),
      officialStandings: official,
      values,
      listed: new Map(listedRows.map((r) => [tickerOf(r.clubId), r.division as "A" | "B"])),
      buybackMultiple: rules.bp / 10_000,
    };
  }

  /** O valor justo de cada clube listado (por ticker) no instante. */
  async compute(seasonId: number, now: Date, executor: Database | DrizzleTx = this.db): Promise<Map<string, Cents>> {
    return fairValuesAt(await this.load(seasonId, executor), now.getTime());
  }
}
