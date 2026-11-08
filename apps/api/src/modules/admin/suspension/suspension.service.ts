import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type SuspendBody, type SuspensionState } from "@futbolsa/contracts";
import { DB, type Database, type DrizzleTx, lockClubs, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, seasonClubs, seasons } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../current-season.js";
import { AdminEvents } from "../events.js";
import { AdminLogService } from "../log/index.js";
import { MarketPort } from "../results/ports.js";

const noSeason = () => new DomainError("no_season", 409, ADMIN_ERROR_MESSAGES.no_season);

/**
 * Suspender a negociação de um clube ou do mercado todo, com motivo que todos veem (Admin, "Suspender a
 * negociação", critérios 23 e 24). A F7 guarda o estado e chama a porta do mercado (a F9 implementa): a recusa
 * de ordem de clube suspenso e o cancelamento permitido durante a suspensão são dela. As ordens dos jogadores
 * ficam no livro; só as cotações da casa saem.
 *
 * Travas na ordem do jogo (temporada, depois clubes por ticker): um clube trava a temporada compartilhada e o
 * clube; o mercado todo trava a temporada exclusiva e **todos** os clubes, como o fim da negociação. Assim
 * suspender e retomar ao mesmo tempo nunca ficam esperando um ao outro em círculo.
 */
@Injectable()
export class SuspensionService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly log: AdminLogService,
    private readonly market: MarketPort,
    private readonly events: AdminEvents,
  ) {}

  async state(): Promise<SuspensionState> {
    return this.stateOf(this.db, (await currentSeason(this.db))?.id ?? null);
  }

  async suspend(actorId: string, body: SuspendBody): Promise<SuspensionState> {
    return withTransaction(this.db, async (tx) => {
      const season = await currentSeason(tx.db);
      if (!season) throw noSeason();
      if (body.ticker) {
        const club = await this.lockOneClub(tx, season.id, body.ticker);
        if (club.suspendedReason !== null) throw new DomainError("already_suspended", 409, ADMIN_ERROR_MESSAGES.already_suspended);
        await tx.db
          .update(seasonClubs)
          .set({ suspendedReason: body.reason })
          .where(and(eq(seasonClubs.seasonId, season.id), eq(seasonClubs.clubId, club.clubId)));
        await this.market.cancelHouseQuotes(tx, [body.ticker]);
        await this.log.record(tx, {
          actorId,
          action: "suspension.set",
          targetType: "club",
          targetId: body.ticker,
          before: { reason: null },
          after: { reason: body.reason },
          reason: body.reason,
        });
        this.events.marketSuspended(tx, { scope: "club", ticker: body.ticker, reason: body.reason });
      } else {
        const locked = await lockSeason(tx, season.id, "update");
        if (locked.suspendedReason !== null) throw new DomainError("already_suspended", 409, ADMIN_ERROR_MESSAGES.already_suspended);
        const all = await this.listedTickers(tx, season.id);
        await lockClubs(tx, season.id, all);
        await tx.db.update(seasons).set({ suspendedReason: body.reason }).where(eq(seasons.id, season.id));
        await this.market.cancelHouseQuotes(tx, all);
        await this.log.record(tx, {
          actorId,
          action: "suspension.set",
          targetType: "market",
          targetId: String(season.id),
          before: { reason: null },
          after: { reason: body.reason },
          reason: body.reason,
        });
        this.events.marketSuspended(tx, { scope: "market", ticker: null, reason: body.reason });
      }
      return this.stateOf(tx.db, season.id);
    });
  }

  /** Retomar um clube (com `ticker`) ou o mercado todo (sem). Retomar o mercado não retoma o clube suspenso à parte. */
  async resume(actorId: string, ticker: string | undefined): Promise<SuspensionState> {
    return withTransaction(this.db, async (tx) => {
      const season = await currentSeason(tx.db);
      if (!season) throw noSeason();
      if (ticker) {
        const club = await this.lockOneClub(tx, season.id, ticker);
        if (club.suspendedReason === null) throw new DomainError("not_suspended", 409, ADMIN_ERROR_MESSAGES.not_suspended);
        await tx.db.update(seasonClubs).set({ suspendedReason: null }).where(and(eq(seasonClubs.seasonId, season.id), eq(seasonClubs.clubId, club.clubId)));
        await this.market.requestRefresh(tx, [ticker], "resume");
        await this.log.record(tx, {
          actorId,
          action: "suspension.clear",
          targetType: "club",
          targetId: ticker,
          before: { reason: club.suspendedReason },
          after: { reason: null },
        });
        this.events.marketResumed(tx, { scope: "club", ticker });
      } else {
        const locked = await lockSeason(tx, season.id, "update");
        if (locked.suspendedReason === null) throw new DomainError("not_suspended", 409, ADMIN_ERROR_MESSAGES.not_suspended);
        const all = await this.listedTickers(tx, season.id);
        const lockedClubs = await lockClubs(tx, season.id, all);
        await tx.db.update(seasons).set({ suspendedReason: null }).where(eq(seasons.id, season.id));
        // O clube suspenso à parte continua parado: só os outros voltam a ter cotação da casa.
        await this.market.requestRefresh(
          tx,
          lockedClubs.filter((c) => c.suspendedReason === null).map((c) => c.ticker),
          "resume",
        );
        await this.log.record(tx, {
          actorId,
          action: "suspension.clear",
          targetType: "market",
          targetId: String(season.id),
          before: { reason: locked.suspendedReason },
          after: { reason: null },
        });
        this.events.marketResumed(tx, { scope: "market", ticker: null });
      }
      return this.stateOf(tx.db, season.id);
    });
  }

  /** Trava a temporada (compartilhada) e o clube; o clube precisa estar listado nela. */
  private async lockOneClub(tx: Tx, seasonId: number, ticker: string) {
    const listed = await this.listedTickers(tx, seasonId);
    if (!listed.includes(ticker)) throw new DomainError("club_not_listed", 404, ADMIN_ERROR_MESSAGES.club_not_listed);
    await lockSeason(tx, seasonId, "share");
    const [club] = await lockClubs(tx, seasonId, [ticker]);
    return club!;
  }

  private async listedTickers(tx: Tx, seasonId: number): Promise<string[]> {
    const rows = await tx.db
      .select({ ticker: clubs.ticker })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, seasonId));
    return rows.map((r) => r.ticker!).sort();
  }

  private async stateOf(db: Database | DrizzleTx, seasonId: number | null): Promise<SuspensionState> {
    if (seasonId === null) return { market: null, clubs: [] };
    const [season] = await db.select({ reason: seasons.suspendedReason }).from(seasons).where(eq(seasons.id, seasonId));
    const suspended = await db
      .select({ ticker: clubs.ticker, reason: seasonClubs.suspendedReason })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      // Só os clubes desta temporada: a suspensão de uma temporada encerrada não vale para a atual.
      .where(and(eq(seasonClubs.seasonId, seasonId), isNotNull(seasonClubs.suspendedReason)))
      .orderBy(asc(clubs.ticker));
    return {
      market: season?.reason ? { reason: season.reason } : null,
      clubs: suspended.map((s) => ({ ticker: s.ticker!, reason: s.reason! })),
    };
  }
}
