import { Module } from "@nestjs/common";
import { RealtimeModule } from "../../infra/realtime/index.js";
import { CloseService } from "./close.service.js";
import { LiveService } from "./live.service.js";
import { OfficialService } from "./official.service.js";
import { RankingsController } from "./rankings.controller.js";
import { RankingsService } from "./rankings.service.js";
import { RankingsPortAdapter, RecalcService } from "./recalc.service.js";

/** Rankings mensal e anual: fechamento oficial, recálculo, parcial ao vivo e leituras (Plano dos rankings). */
@Module({
  imports: [RealtimeModule],
  controllers: [RankingsController],
  providers: [CloseService, RecalcService, RankingsPortAdapter, LiveService, OfficialService, RankingsService],
  exports: [CloseService, RecalcService, RankingsPortAdapter, LiveService, RankingsService],
})
export class RankingsModule {}
