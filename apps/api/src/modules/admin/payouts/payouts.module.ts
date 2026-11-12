import { Module } from "@nestjs/common";
import { DividendsModule } from "../../dividends/dividends.module.js";
import { RealtimeModule } from "../../../infra/realtime/index.js";
import { PortfolioModule } from "../../portfolio/index.js";
import { AdminLogModule } from "../log/index.js";
import { ResultsModule } from "../results/results.module.js";
import { StandingsModule } from "../standings/standings.module.js";
import { ApplyCorrectionService } from "./apply-correction.service.js";
import { ApproveService } from "./approve.service.js";
import { SettleReversalService } from "./settle-reversal.js";
import { CloseEventsJob } from "./close-events.job.js";
import { CloseEventsService } from "./close-events.service.js";
import { CorrectionPlanService } from "./correction-plan.js";
import { CorrectionsController } from "./corrections.controller.js";
import { EngineInputService } from "./engine-input.js";
import { PayoutsController } from "./payouts.controller.js";
import { PayoutEvents } from "./events.js";
import { PayoutsStatusService } from "./outstanding.js";
import { NoopRankingsPort, RankingsPort } from "./ports.js";
import { PreviewService } from "./preview.service.js";
import { SettleCreditsService } from "./settle-credits.js";
import { SettleJob } from "./settle.job.js";

/**
 * Pagamentos de dividendos (F12; dono: `admin`): foto das posições, fechamento dos eventos, prévia, aprovação em lotes
 * e correção com estorno. A F13 troca o `RankingsPort` vazio pelo de verdade. Do `ResultsModule` vêm o
 * `MatchesEvents` (dispara o fechamento), o `MarketPort` (reposição do formador) e, pelo `MarketModule` que ele
 * reexporta, o `CancelService` (as compras canceladas no estorno); do `StandingsModule`, o
 * `StandingsEvents`; do `PortfolioModule`, o `PortfolioLedger` (o crédito); do `AdminLogModule`, o registro.
 */
@Module({
  imports: [RealtimeModule, DividendsModule, ResultsModule, StandingsModule, PortfolioModule, AdminLogModule],
  controllers: [PayoutsController, CorrectionsController],
  providers: [
    { provide: RankingsPort, useClass: NoopRankingsPort },
    EngineInputService,
    CloseEventsService,
    CloseEventsJob,
    PreviewService,
    CorrectionPlanService,
    ApproveService,
    ApplyCorrectionService,
    PayoutsStatusService,
    PayoutEvents,
    SettleReversalService,
    SettleCreditsService,
    SettleJob,
  ],
  exports: [PayoutsStatusService, RankingsPort, EngineInputService, CloseEventsService, CorrectionPlanService, SettleCreditsService, SettleReversalService],
})
export class PayoutsModule {}
