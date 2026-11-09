import { Module } from "@nestjs/common";
import { DividendsModule } from "../../dividends/dividends.module.js";
import { EngineInputService } from "./engine-input.js";
import { NoopRankingsPort, RankingsPort } from "./ports.js";

/**
 * Pagamentos de dividendos (F12; dono: `admin`): foto das posições, fechamento dos eventos, prévia, aprovação em lotes
 * e correção com estorno. A F13 troca o `RankingsPort` vazio pelo de verdade.
 */
@Module({
  imports: [DividendsModule],
  providers: [{ provide: RankingsPort, useClass: NoopRankingsPort }, EngineInputService],
  exports: [RankingsPort, EngineInputService],
})
export class PayoutsModule {}
