import { Inject, Injectable } from "@nestjs/common";
import { asc, eq, isNotNull } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  COMMON_ERROR_MESSAGES,
  type CurrentSeasonResponse,
  type PatchSeasonBody,
  type PublicSeason,
  type PutSeasonClubsBody,
  type SeasonView,
} from "@futbolsa/contracts";
import { ipoDates } from "@futbolsa/engine";
import { DB, type Database, type DrizzleTx, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, seasonClubs, seasons } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { SeasonValuesService } from "../../dividends/season-values/season-values.service.js";
import { currentSeason, type SeasonRow } from "../current-season.js";
import { AdminLogService } from "../log/index.js";

export const toSeasonView = (s: SeasonRow): SeasonView => ({
  id: s.id,
  year: s.year,
  status: s.status as SeasonView["status"],
  offerSize: s.offerSize,
  firstKickoff: s.firstKickoff?.toISOString() ?? null,
  ipoOpensAt: s.ipoOpensAt?.toISOString() ?? null,
  ipoClosesAt: s.ipoClosesAt?.toISOString() ?? null,
  tradingOpensAt: s.tradingOpensAt?.toISOString() ?? null,
  suspendedReason: s.suspendedReason,
});

const invalid = (...fields: string[]) => new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, fields);
const notFound = () => new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);

/**
 * Preparar a temporada (Admin, "Temporada e IPO"; IPO por bookbuilding, critério 7): criar, definir a oferta e a
 * data do primeiro jogo (que calcula as datas do IPO) e confirmar os clubes com a divisão e a colocação anterior.
 * Depois da abertura do IPO nada disto muda. Só há uma temporada fora de `closed` por vez.
 */
@Injectable()
export class SeasonsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly log: AdminLogService,
    private readonly values: SeasonValuesService,
  ) {}

  /** `GET /season` (público): a temporada atual e os clubes suspensos com o motivo, para todos verem. */
  async publicView(): Promise<PublicSeason> {
    const season = await currentSeason(this.db);
    if (!season) return { season: null, suspendedClubs: [] };
    const suspended = await this.db
      .select({ ticker: clubs.ticker, reason: seasonClubs.suspendedReason })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(isNotNull(seasonClubs.suspendedReason))
      .orderBy(asc(clubs.ticker));
    return {
      season: toSeasonView(season),
      suspendedClubs: suspended.filter((s) => s.ticker && s.reason).map((s) => ({ ticker: s.ticker!, reason: s.reason! })),
    };
  }

  async current(): Promise<CurrentSeasonResponse> {
    const season = await currentSeason(this.db);
    if (!season) return { season: null, clubs: [] };
    return { season: toSeasonView(season), clubs: await this.clubsOf(this.db, season.id) };
  }

  async create(actorId: string, year: number): Promise<SeasonView> {
    return withTransaction(this.db, async (tx) => {
      if (await currentSeason(tx.db)) throw new DomainError("season_exists", 409, ADMIN_ERROR_MESSAGES.season_exists);
      const [created] = await tx.db.insert(seasons).values({ year }).returning();
      await this.values.createInitial(tx, created!.id);
      await this.log.record(tx, {
        actorId,
        action: "season.create",
        targetType: "season",
        targetId: String(created!.id),
        after: { year },
      });
      return toSeasonView(created!);
    });
  }

  async patch(actorId: string, id: number, body: PatchSeasonBody): Promise<SeasonView> {
    return withTransaction(this.db, async (tx) => {
      const season = await this.lockPreparing(tx, id);
      const dates = body.firstKickoff ? ipoDates(Date.parse(body.firstKickoff)) : null;
      const [updated] = await tx.db
        .update(seasons)
        .set({
          ...(body.offerSize !== undefined ? { offerSize: body.offerSize } : {}),
          ...(body.firstKickoff !== undefined && dates
            ? {
                firstKickoff: new Date(body.firstKickoff),
                // As datas saem da data do primeiro jogo; a F8 as confirma na abertura das ofertas.
                ipoOpensAt: new Date(dates.opensAt),
                ipoClosesAt: new Date(dates.closesAt),
                tradingOpensAt: new Date(dates.tradingOpensAt),
              }
            : {}),
        })
        .where(eq(seasons.id, id))
        .returning();
      await this.log.record(tx, {
        actorId,
        action: "season.update",
        targetType: "season",
        targetId: String(id),
        before: { offerSize: season.offerSize, firstKickoff: season.firstKickoff?.toISOString() ?? null },
        after: { offerSize: updated!.offerSize, firstKickoff: updated!.firstKickoff?.toISOString() ?? null },
        reason: body.reason,
      });
      return toSeasonView(updated!);
    });
  }

  /** Confirma a lista de clubes: troca a lista inteira, enquanto a temporada está em preparação. */
  async putClubs(actorId: string, id: number, body: PutSeasonClubsBody): Promise<CurrentSeasonResponse["clubs"]> {
    return withTransaction(this.db, async (tx) => {
      await this.lockPreparing(tx, id);
      const ids = body.clubs.map((c) => c.clubId);
      const inA = body.clubs.filter((c) => c.division === "A");
      const placements = body.clubs.map((c) => c.prevPlacement).filter((p): p is number => p !== null);
      if (
        inA.length !== 20 ||
        new Set(ids).size !== ids.length ||
        new Set(placements).size !== placements.length ||
        inA.some((c) => c.prevPlacement === null) ||
        body.clubs.some((c) => c.division === "B" && c.prevPlacement !== null)
      ) {
        // 20 clubes na Série A, sem repetir; colocação anterior de 1 a 24 sem repetir, só para a Série A.
        throw invalid("clubs");
      }
      const known = await tx.db.select().from(clubs);
      const byId = new Map(known.map((c) => [c.id, c]));
      if (ids.some((clubId) => !byId.get(clubId)?.ticker)) throw invalid("clubs"); // todo clube listado tem ticker

      const before = await this.clubsOf(tx.db, id);
      await tx.db.delete(seasonClubs).where(eq(seasonClubs.seasonId, id));
      await tx.db.insert(seasonClubs).values(
        body.clubs.map((c) => ({ seasonId: id, clubId: c.clubId, division: c.division, prevPlacement: c.prevPlacement })),
      );
      const after = await this.clubsOf(tx.db, id);
      const compact = (rows: typeof after) => rows.map((r) => ({ clubId: r.club.id, division: r.division, prevPlacement: r.prevPlacement }));
      await this.log.record(tx, {
        actorId,
        action: "season.clubs.update",
        targetType: "season",
        targetId: String(id),
        before: { clubs: compact(before) },
        after: { clubs: compact(after) },
        reason: body.reason,
      });
      return after;
    });
  }

  /** A temporada travada (exclusiva) e ainda em preparação; depois da abertura do IPO, 409. */
  private async lockPreparing(tx: Tx, id: number): Promise<SeasonRow> {
    const [exists] = await tx.db.select({ id: seasons.id }).from(seasons).where(eq(seasons.id, id));
    if (!exists) throw notFound();
    const season = await lockSeason(tx, id, "update");
    if (season.status !== "preparing") throw new DomainError("ipo_opened", 409, ADMIN_ERROR_MESSAGES.ipo_opened);
    return season;
  }

  private async clubsOf(db: Database | DrizzleTx, seasonId: number): Promise<CurrentSeasonResponse["clubs"]> {
    const rows = await db
      .select({ sc: seasonClubs, club: clubs })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, seasonId))
      .orderBy(asc(seasonClubs.division), asc(seasonClubs.prevPlacement), asc(clubs.name));
    return rows.map((r) => ({
      club: { id: r.club.id, ticker: r.club.ticker, name: r.club.name },
      division: r.sc.division as "A" | "B",
      prevPlacement: r.sc.prevPlacement,
    }));
  }
}
