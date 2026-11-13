import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import {
  MARKET_MAKER_ERROR_MESSAGES,
  type MarketMakerBody,
  type MarketMakerClubStatus,
  type MarketMakerState,
  type MarketMakerView,
} from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, type DrizzleTx, lockSeason, withTransaction } from "../../../infra/db/index.js";
import { clubs, positions, seasonClubs, seasons, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { AdminLogService } from "../../admin/log/index.js";
import { assertSeasonOpen } from "../../admin/seasons/season-state.js";
import { clubsInMatch } from "../state/match-mode.js";

const stateOf = (s: typeof seasons.$inferSelect): MarketMakerState => ({
  mmQuantityBp: s.mmQuantityBp,
  mmMatchQuantityBp: s.mmMatchQuantityBp,
  mmMinSideQty: s.mmMinSideQty,
  mmMatchMinSideQty: s.mmMatchMinSideQty,
  mmLotBp: s.mmLotBp,
});

/**
 * Os percentuais da quantidade do formador e os mínimos por lado, que o admin muda com motivo no registro (Livro de
 * ofertas, "Quantidade", critério 34). O valor novo vale a partir da reposição seguinte: a reposição lê `seasons` a
 * cada vez, então não há nada a refazer aqui. O lote (`mm_lot_bp`) é fixo desde a abertura do IPO, porque a
 * oferta e a tesouraria já foram calculadas com ele.
 */
@Injectable()
export class MarketMakerAdminService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly log: AdminLogService,
    private readonly clock: Clock,
  ) {}

  async state(executor: Database | DrizzleTx = this.db): Promise<MarketMakerState> {
    const season = await currentSeason(executor);
    if (!season) throw new DomainError("no_season", 409, MARKET_MAKER_ERROR_MESSAGES.no_season);
    return stateOf(season);
  }

  /**
   * Os valores em vigor e o que a tesouraria tem em cada clube (prancha 7l): só leitura, sem trava, porque o admin
   * só olha. As ações livres descontam as presas em ordens abertas da casa; a situação segue a ordem suspenso, leilão,
   * jogo, negociando. Sem tesouraria (a abertura do IPO a cria), o campo vai nulo.
   */
  async view(): Promise<MarketMakerView> {
    const season = await currentSeason(this.db);
    if (!season) throw new DomainError("no_season", 409, MARKET_MAKER_ERROR_MESSAGES.no_season);
    const [wallet] = await this.db
      .select({ id: wallets.id, cash: wallets.cash, reservedCash: wallets.reservedCash })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), eq(wallets.ownerType, "treasury")));
    if (!wallet) return { ...stateOf(season), treasury: null };
    const rows = await this.db
      .select({
        clubId: seasonClubs.clubId,
        ticker: clubs.ticker,
        totalShares: seasonClubs.totalShares,
        suspendedReason: seasonClubs.suspendedReason,
        auctionOpenedAt: seasonClubs.auctionOpenedAt,
        auctionUntil: seasonClubs.auctionUntil,
        shares: positions.shares,
        reservedShares: positions.reservedShares,
      })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .leftJoin(positions, and(eq(positions.clubId, seasonClubs.clubId), eq(positions.walletId, wallet.id)))
      .where(and(eq(seasonClubs.seasonId, season.id), isNotNull(clubs.ticker)))
      .orderBy(asc(clubs.ticker));
    const playing = new Set(await clubsInMatch(this.db, season.id, this.clock.now()));
    return {
      ...stateOf(season),
      treasury: {
        cash: wallet.cash,
        freeCash: wallet.cash - wallet.reservedCash,
        clubs: rows.map((r) => {
          const status: MarketMakerClubStatus =
            season.suspendedReason !== null || r.suspendedReason !== null ? "suspended" : r.auctionOpenedAt !== null ? "auction" : playing.has(r.clubId) ? "in_match" : "trading";
          return {
            ticker: r.ticker!,
            totalShares: r.totalShares,
            freeShares: (r.shares ?? 0) - (r.reservedShares ?? 0),
            status,
            auctionUntil: status === "auction" && r.auctionUntil ? r.auctionUntil.toISOString() : null,
          };
        }),
      },
    };
  }

  async update(actorId: string, body: MarketMakerBody): Promise<MarketMakerState> {
    return withTransaction(this.db, async (tx) => {
      const found = await currentSeason(tx.db);
      if (!found) throw new DomainError("no_season", 409, MARKET_MAKER_ERROR_MESSAGES.no_season);
      // trava a temporada: duas mudanças ao mesmo tempo não se pisam, e o antes e o depois do registro são verdadeiros
      const season = await lockSeason(tx, found.id, "update");
      // o encerramento pode ter passado enquanto a trava era esperada (F15, T7)
      assertSeasonOpen(season);
      if (body.mmLotBp !== undefined && body.mmLotBp !== season.mmLotBp && season.status !== "preparing") {
        throw new DomainError("lot_locked", 409, MARKET_MAKER_ERROR_MESSAGES.lot_locked);
      }
      const before = stateOf(season);
      const after: MarketMakerState = {
        mmQuantityBp: body.mmQuantityBp ?? before.mmQuantityBp,
        mmMatchQuantityBp: body.mmMatchQuantityBp ?? before.mmMatchQuantityBp,
        mmMinSideQty: body.mmMinSideQty ?? before.mmMinSideQty,
        mmMatchMinSideQty: body.mmMatchMinSideQty ?? before.mmMatchMinSideQty,
        mmLotBp: body.mmLotBp ?? before.mmLotBp,
      };
      await tx.db.update(seasons).set(after).where(eq(seasons.id, season.id));
      await this.log.record(tx, {
        actorId,
        action: "market-maker.update",
        targetType: "season",
        targetId: String(season.id),
        before,
        after,
        reason: body.reason,
      });
      return after;
    });
  }
}
