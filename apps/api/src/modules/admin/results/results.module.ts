import { Module } from "@nestjs/common";
import { ImportService } from "./import.service.js";
import { MarketPort, MatchesEvents, NoopMarketPort } from "./ports.js";

/**
 * Fontes, importação, jogos, pendências e tarefas agendadas (Plano do admin base, T4 a T10). A F9 troca
 * o `MarketPort` vazio pelo de verdade; a F12 assina o `MatchesEvents`.
 */
@Module({
  providers: [ImportService, MatchesEvents, { provide: MarketPort, useClass: NoopMarketPort }],
  exports: [ImportService, MatchesEvents, MarketPort],
})
export class ResultsModule {}
