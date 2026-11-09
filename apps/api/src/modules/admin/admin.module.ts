import { Module } from "@nestjs/common";
import { IpoModule } from "../ipo/index.js";
import { AdminLogModule } from "./log/index.js";
import { OverviewController, OverviewService } from "./overview.service.js";
import { ResultsModule } from "./results/results.module.js";
import { SeasonsModule } from "./seasons/seasons.module.js";
import { StandingsModule } from "./standings/standings.module.js";
import { SuspensionModule } from "./suspension/suspension.module.js";

/**
 * Admin (resultados, temporada, suspensão e registro; pagamentos e jogadores chegam nas F12 e F14).
 * Cada subpasta tem o próprio módulo; a visão geral junta o que elas calculam, mais o que falta para
 * abrir o IPO (do módulo `ipo`, que nunca importa o `admin` de volta).
 */
@Module({
  imports: [AdminLogModule, ResultsModule, StandingsModule, SeasonsModule, SuspensionModule, IpoModule],
  controllers: [OverviewController],
  providers: [OverviewService],
})
export class AdminModule {}
