import { Module } from "@nestjs/common";
import { CloseService } from "./close.service.js";
import { RankingsPortAdapter, RecalcService } from "./recalc.service.js";

/** Rankings mensal e anual: fechamento oficial, recálculo, parcial ao vivo e leituras (Plano dos rankings). */
@Module({
  providers: [CloseService, RecalcService, RankingsPortAdapter],
  exports: [CloseService, RecalcService, RankingsPortAdapter],
})
export class RankingsModule {}
