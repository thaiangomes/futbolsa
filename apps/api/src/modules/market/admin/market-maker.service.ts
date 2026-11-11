import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import {
  MARKET_MAKER_ERROR_MESSAGES,
  type MarketMakerBody,
  type MarketMakerState,
} from "@futbolsa/contracts";
import { DB, type Database, type DrizzleTx, lockSeason, withTransaction } from "../../../infra/db/index.js";
import { seasons } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { AdminLogService } from "../../admin/log/index.js";

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
  ) {}

  async state(executor: Database | DrizzleTx = this.db): Promise<MarketMakerState> {
    const season = await currentSeason(executor);
    if (!season) throw new DomainError("no_season", 409, MARKET_MAKER_ERROR_MESSAGES.no_season);
    return stateOf(season);
  }

  async update(actorId: string, body: MarketMakerBody): Promise<MarketMakerState> {
    return withTransaction(this.db, async (tx) => {
      const found = await currentSeason(tx.db);
      if (!found) throw new DomainError("no_season", 409, MARKET_MAKER_ERROR_MESSAGES.no_season);
      // trava a temporada: duas mudanças ao mesmo tempo não se pisam, e o antes e o depois do registro são verdadeiros
      const season = await lockSeason(tx, found.id, "update");
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
