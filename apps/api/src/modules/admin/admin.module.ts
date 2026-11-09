import { Module } from "@nestjs/common";
import { AdminLogModule } from "./log/index.js";
import { OverviewController, OverviewService } from "./overview.service.js";
import { PayoutsModule } from "./payouts/payouts.module.js";
import { ResultsModule } from "./results/results.module.js";
import { SeasonsModule } from "./seasons/seasons.module.js";
import { StandingsModule } from "./standings/standings.module.js";
import { SuspensionModule } from "./suspension/suspension.module.js";

/**
 * Admin (resultados, temporada, suspensão e registro; pagamentos na F12; jogadores chegam na F14).
 * Cada subpasta tem o próprio módulo; a visão geral junta o que elas calculam.
 */
@Module({
  imports: [AdminLogModule, ResultsModule, PayoutsModule, StandingsModule, SeasonsModule, SuspensionModule],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class AdminModule {}
