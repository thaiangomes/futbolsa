import { Body, Controller, Get, HttpCode, Inject, Post } from "@nestjs/common";
import { desc } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  type ApplyCorrectionBody,
  applyCorrectionBodySchema,
  type ApplyCorrectionResponse,
  type CorrectionPreview,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { seasons } from "../../../infra/db/schema/index.js";
import { DomainError, ZodValidationPipe } from "../../../infra/http/index.js";
import { currentSeason } from "../current-season.js";
import { ApplyCorrectionService } from "./apply-correction.service.js";
import { CorrectionPlanService } from "./correction-plan.js";
import { SettleCreditsService } from "./settle-credits.js";

/**
 * A correção depois de pago (Admin, "Correção depois de pago", critérios 12, 13, 17, 18, 31 e 33): a prévia, só de
 * leitura, com o código do plano (P7), e a aplicação com o código e o motivo. Mesma rota-base do `PayoutsController`.
 */
@AdminOnly()
@Controller("admin/payouts")
export class CorrectionsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly plans: CorrectionPlanService,
    private readonly applier: ApplyCorrectionService,
    private readonly settle: SettleCreditsService,
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

  /**
   * Aplica a prévia do código dado (etapa 1: as versões novas já aprovadas, numa transação). A resposta sai depois do
   * `COMMIT`; os estornos e complementos seguem em segundo plano, e a prévia dos pagamentos mostra "liquidando" até
   * acabar. Código velho: 409 `correction_stale` com a prévia nova. Sem motivo: 400.
   */
  @Post("corrections")
  @HttpCode(200)
  async apply(
    @CurrentUser() admin: ResolvedUser,
    @Body(new ZodValidationPipe(applyCorrectionBodySchema)) body: ApplyCorrectionBody,
  ): Promise<ApplyCorrectionResponse> {
    const response = await this.applier.apply(admin.id, body);
    if (response.events.length > 0) this.settle.trigger();
    return response;
  }
}
