import { Module } from "@nestjs/common";
import { DividendsModule } from "../../dividends/dividends.module.js";
import { ResultsModule } from "../results/results.module.js";
import { StandingsModule } from "../standings/standings.module.js";
import { CloseEventsJob } from "./close-events.job.js";
import { CloseEventsService } from "./close-events.service.js";
import { CorrectionPlanService } from "./correction-plan.js";
import { CorrectionsController } from "./corrections.controller.js";
import { EngineInputService } from "./engine-input.js";
import { PayoutsController } from "./payouts.controller.js";
import { NoopRankingsPort, RankingsPort } from "./ports.js";
import { PreviewService } from "./preview.service.js";

/**
 * Pagamentos de dividendos (F12; dono: `admin`): foto das posições, fechamento dos eventos, prévia, aprovação em lotes
 * e correção com estorno. A F13 troca o `RankingsPort` vazio pelo de verdade. Do `ResultsModule` vêm o
 * `MatchesEvents` (dispara o fechamento) e o `MarketPort` (reposição do formador); do `StandingsModule`, o
 * `StandingsEvents`.
 */
@Module({
  imports: [DividendsModule, ResultsModule, StandingsModule],
  controllers: [PayoutsController, CorrectionsController],
  providers: [
    { provide: RankingsPort, useClass: NoopRankingsPort },
    EngineInputService,
    CloseEventsService,
    CloseEventsJob,
    PreviewService,
    CorrectionPlanService,
  ],
  exports: [RankingsPort, EngineInputService, CloseEventsService, CorrectionPlanService],
})
export class PayoutsModule {}
