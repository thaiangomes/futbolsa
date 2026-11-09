import { Module } from "@nestjs/common";
import { NoopRankingsPort, RankingsPort } from "./ports.js";

/**
 * Pagamentos de dividendos (F12; dono: `admin`): foto das posições, fechamento dos eventos, prévia, aprovação em lotes
 * e correção com estorno. A F13 troca o `RankingsPort` vazio pelo de verdade.
 */
@Module({
  providers: [{ provide: RankingsPort, useClass: NoopRankingsPort }],
  exports: [RankingsPort],
})
export class PayoutsModule {}
