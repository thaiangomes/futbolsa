import { Module } from "@nestjs/common";
import { RealtimeModule } from "../../../infra/realtime/index.js";
import { AdminEvents } from "../events.js";
import { AdminLogModule } from "../log/index.js";
import { StandingsModule } from "../standings/standings.module.js";
import { ImportRunner } from "./import-runner.js";
import { ImportService } from "./import.service.js";
import { ImportsController } from "./imports.controller.js";
import { ResultsJobs } from "./jobs.js";
import { MatchesController } from "./matches.controller.js";
import { MatchesService } from "./matches.service.js";
import { PendingController } from "./pending.controller.js";
import { PendingService } from "./pending.service.js";
import { MarketPort, MatchesEvents, NoopMarketPort } from "./ports.js";
import { parseResultSources, ResultSourceRegistry } from "./sources/registry.js";

/**
 * Fontes, importação, jogos, pendências e tarefas agendadas (Plano do admin base, T4 a T10). A F9 troca
 * o `MarketPort` vazio pelo de verdade; a F12 assina o `MatchesEvents`.
 */
@Module({
  imports: [AdminLogModule, StandingsModule, RealtimeModule],
  controllers: [PendingController, MatchesController, ImportsController],
  providers: [
    ImportService,
    ImportRunner,
    ResultsJobs,
    PendingService,
    AdminEvents,
    MatchesService,
    MatchesEvents,
    { provide: MarketPort, useClass: NoopMarketPort },
    { provide: ResultSourceRegistry, useFactory: () => parseResultSources(process.env) },
  ],
  exports: [ImportService, ImportRunner, PendingService, AdminEvents, MatchesService, MatchesEvents, MarketPort],
})
export class ResultsModule {}
