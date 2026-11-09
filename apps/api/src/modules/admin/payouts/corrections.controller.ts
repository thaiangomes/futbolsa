import { Controller, Get, HttpCode, Inject } from "@nestjs/common";
import { desc } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type CorrectionPreview } from "@futbolsa/contracts";
import { AdminOnly } from "../../../infra/auth-adapter/index.js";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { seasons } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../current-season.js";
import { CorrectionPlanService } from "./correction-plan.js";

/**
 * A correção depois de pago (Admin, "Correção depois de pago", critérios 12, 13, 17, 18 e 31): a prévia, só de leitura,
 * com o código do plano (P7). Mesma rota-base do `PayoutsController`; a aplicação (`POST`) é da T7.
 */
@AdminOnly()
@Controller("admin/payouts")
export class CorrectionsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly plans: CorrectionPlanService,
    private readonly clock: Clock,
  ) {}

  @Get("corrections")
  @HttpCode(200)
  async preview(): Promise<CorrectionPreview> {
    const season = await currentSeason(this.db);
    if (season) return (await this.plans.plan(this.db, season.id, this.clock.now())).preview;
    // sem temporada aberta: se a última foi encerrada, a recusa é a dela (critério 18), senão não há temporada
    const [latest] = await this.db.select({ status: seasons.status }).from(seasons).orderBy(desc(seasons.year)).limit(1);
    if (latest?.status === "closed") throw new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);
    throw new DomainError("no_season", 409, ADMIN_ERROR_MESSAGES.no_season);
  }
}
