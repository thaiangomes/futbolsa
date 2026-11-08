import { Module } from "@nestjs/common";
import { ImportService } from "./import.service.js";
import { PendingController } from "./pending.controller.js";
import { PendingService } from "./pending.service.js";
import { MarketPort, MatchesEvents, NoopMarketPort } from "./ports.js";

/**
 * Fontes, importação, jogos, pendências e tarefas agendadas (Plano do admin base, T4 a T10). A F9 troca
 * o `MarketPort` vazio pelo de verdade; a F12 assina o `MatchesEvents`.
 */
@Module({
  controllers: [PendingController],
  providers: [ImportService, PendingService, MatchesEvents, { provide: MarketPort, useClass: NoopMarketPort }],
  exports: [ImportService, PendingService, MatchesEvents, MarketPort],
})
export class ResultsModule {}
