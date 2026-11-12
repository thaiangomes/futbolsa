import { Module } from "@nestjs/common";
import { CloseService } from "./close.service.js";

/** Rankings mensal e anual: fechamento oficial, recálculo, parcial ao vivo e leituras (Plano dos rankings). */
@Module({
  providers: [CloseService],
  exports: [CloseService],
})
export class RankingsModule {}
