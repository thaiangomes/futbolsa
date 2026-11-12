import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import {
  MONTH_KEY_PATTERN,
  RANKING_ERROR_MESSAGES,
  YEAR_KEY_PATTERN,
  type OfficialRanking,
  type RankingHistory,
  type RankingPageQuery,
} from "@futbolsa/contracts";
import { DB, type Database, withTransaction } from "../../infra/db/index.js";
import { seasons } from "../../infra/db/schema/index.js";
import { DomainError } from "../../infra/http/index.js";
import { currentHeads, currentSnapshot, type Period, type SnapshotHead } from "./snapshots.js";
import { returnOf, toRankingRows } from "./view.js";

/** As leituras oficiais (T8): a versão atual de cada ranking fechado, o índice e os campeões. Só `SELECT`, públicas, sem patrimônio em R$ (P7). */
@Injectable()
export class OfficialService {
  constructor(@Inject(DB) private readonly db: Database) {}

  private invalid(): DomainError {
    return new DomainError("invalid_period", 400, RANKING_ERROR_MESSAGES.invalid_period);
  }

  /** `GET /rankings/month/:yyyy-mm`. */
  month(key: string, query: RankingPageQuery): Promise<OfficialRanking> {
    if (!MONTH_KEY_PATTERN.test(key)) throw this.invalid();
    return this.read("month", key, Number(key.slice(0, 4)), query);
  }

  /** `GET /rankings/season/:ano`. */
  season(year: string, query: RankingPageQuery): Promise<OfficialRanking> {
    if (!YEAR_KEY_PATTERN.test(year)) throw this.invalid();
    return this.read("season", year, Number(year), query);
  }

  private async read(period: Period, key: string, year: number, query: RankingPageQuery): Promise<OfficialRanking> {
    return withTransaction(
      this.db,
      async (tx) => {
        const [season] = await tx.db.select().from(seasons).where(eq(seasons.year, year));
        const head = season ? await currentSnapshot(tx, season.id, period, key) : null;
        if (!season || !head) {
          if (season && period === "season" && season.status !== "closed") {
            throw new DomainError("season_not_closed", 409, RANKING_ERROR_MESSAGES.season_not_closed);
          }
          throw new DomainError("ranking_not_found", 404, RANKING_ERROR_MESSAGES.ranking_not_found);
        }
        const total = Number((await tx.db.execute(sql`select count(*)::int as n from futbolsa.ranking_rows where snapshot_id = ${head.id}`)).rows[0]!.n);
        const page = await tx.db.execute(sql`
          select wallet_id, base, equity, position from futbolsa.ranking_rows where snapshot_id = ${head.id}
          order by position, wallet_id offset ${query.offset} limit ${query.limit}`);
        const rows = await toRankingRows(
          tx,
          season.id,
          page.rows.map((r) => ({ walletId: Number(r.wallet_id), position: Number(r.position), returnBp: returnOf(Number(r.equity), Number(r.base)) })),
        );
        return { period, periodKey: key, closedAt: head.closedAt.toISOString(), version: head.version, botsIncluded: head.botsIncluded, total, offset: query.offset, rows };
      },
      { readOnly: true, isolationLevel: "repeatable read" },
    );
  }

  /** `GET /rankings/history`: temporadas com ranking oficial, meses fechados e campeões (o 1º de cada ranking, com os empates). */
  async history(): Promise<RankingHistory> {
    return withTransaction(
      this.db,
      async (tx) => {
        const all = await tx.db.select().from(seasons);
        const out: RankingHistory["seasons"] = [];
        for (const season of all.sort((a, b) => b.year - a.year)) {
          const heads = await currentHeads(tx, season.id);
          if (heads.length === 0) continue;
          const champions = async (head: SnapshotHead) => {
            const top = await tx.db.execute(sql`
              select wallet_id, base, equity, position from futbolsa.ranking_rows where snapshot_id = ${head.id} and position = 1 order by wallet_id`);
            const rows = await toRankingRows(
              tx,
              season.id,
              top.rows.map((r) => ({ walletId: Number(r.wallet_id), position: 1, returnBp: returnOf(Number(r.equity), Number(r.base)) })),
            );
            return rows.map((r) => ({ displayName: r.displayName, isBot: r.isBot, botLabel: r.botLabel, returnBp: r.returnBp }));
          };
          const months: RankingHistory["seasons"][number]["months"] = [];
          let yearly: RankingHistory["seasons"][number]["season"] = null;
          for (const head of heads) {
            const entry = { closedAt: head.closedAt.toISOString(), version: head.version, champions: await champions(head) };
            if (head.period === "month") months.push({ monthKey: head.periodKey, ...entry });
            else yearly = entry;
          }
          months.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
          out.push({ year: season.year, status: season.status, months, season: yearly });
        }
        return { seasons: out };
      },
      { readOnly: true, isolationLevel: "repeatable read" },
    );
  }
}
