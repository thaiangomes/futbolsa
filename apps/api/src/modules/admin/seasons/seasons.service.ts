import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, notInArray, sql } from "drizzle-orm";
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
import { IpoClosingService } from "../../ipo/index.js";
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
const ipoOpened = () => new DomainError("ipo_opened", 409, ADMIN_ERROR_MESSAGES.ipo_opened);

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
    private readonly closing: IpoClosingService,
  ) {}

  /** `GET /season` (público): a temporada atual e os clubes suspensos com o motivo, para todos verem. */
  async publicView(): Promise<PublicSeason> {
    const season = await currentSeason(this.db);
    if (!season) return { season: null, suspendedClubs: [] };
    const suspended = await this.db
      .select({ ticker: clubs.ticker, reason: seasonClubs.suspendedReason })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      // Só os clubes desta temporada: a suspensão de uma temporada encerrada não vale para a atual.
      .where(and(eq(seasonClubs.seasonId, season.id), isNotNull(seasonClubs.suspendedReason)))
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
      // O ano tem de ser maior que o de todas as temporadas já criadas (a chave única recusaria o repetido, e os valores
      // são copiados da temporada anterior).
      const [latest] = await tx.db.select({ year: seasons.year }).from(seasons).orderBy(desc(seasons.year)).limit(1);
      if (latest && year <= latest.year) throw invalid("year");
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

  /**
   * Muda a oferta e o primeiro jogo (só em `preparing`) ou adia o fechamento das ofertas (`ipoClosesAt`, só
   * com o IPO aberto; IPO por bookbuilding, critério 28; Admin, critério 20). Tudo ou nada: com um campo
   * recusado, nada muda. Depois da abertura, a oferta e o primeiro jogo continuam recusados com
   * `ipo_opened`, mesmo junto do `ipoClosesAt` (o primeiro jogo adiado não muda mais as datas, critério 27);
   * o `ipoClosesAt` antes da abertura é `ipo_not_open`.
   */
  async patch(actorId: string, id: number, body: PatchSeasonBody): Promise<SeasonView> {
    if (body.ipoClosesAt === undefined) return this.patchPreparing(actorId, id, body);
    const newClosesAt = new Date(body.ipoClosesAt);
    return withTransaction(this.db, async (tx) => {
      // Uma trava exclusiva só: o adiamento trava de novo no mesmo modo, sem esperar.
      const season = await this.lockExisting(tx, id);
      if ((body.offerSize !== undefined || body.firstKickoff !== undefined) && season.status !== "preparing") throw ipoOpened();
      // Em `preparing`, o adiamento recusa com `ipo_not_open` antes de gravar qualquer coisa.
      const updated = await this.closing.postponeClose(tx, id, newClosesAt, actorId, body.reason);
      return toSeasonView(updated);
    });
  }

  private async patchPreparing(actorId: string, id: number, body: PatchSeasonBody): Promise<SeasonView> {
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
      // Só sai quem deixou a lista; quem continua muda apenas a divisão e a colocação anterior. Apagar e
      // inserir de novo zeraria a suspensão (`suspended_reason`), a banda e os preços de quem já tinha.
      await tx.db.delete(seasonClubs).where(and(eq(seasonClubs.seasonId, id), notInArray(seasonClubs.clubId, ids)));
      await tx.db
        .insert(seasonClubs)
        .values(body.clubs.map((c) => ({ seasonId: id, clubId: c.clubId, division: c.division, prevPlacement: c.prevPlacement })))
        .onConflictDoUpdate({
          target: [seasonClubs.seasonId, seasonClubs.clubId],
          set: { division: sql`excluded.division`, prevPlacement: sql`excluded.prev_placement` },
        });
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
    const season = await this.lockExisting(tx, id);
    if (season.status !== "preparing") throw ipoOpened();
    return season;
  }

  /** A temporada travada (exclusiva), em qualquer status; 404 se não existe. */
  private async lockExisting(tx: Tx, id: number): Promise<SeasonRow> {
    const [exists] = await tx.db.select({ id: seasons.id }).from(seasons).where(eq(seasons.id, id));
    if (!exists) throw notFound();
    return lockSeason(tx, id, "update");
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
