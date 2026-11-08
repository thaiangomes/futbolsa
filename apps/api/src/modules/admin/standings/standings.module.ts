import { Module } from "@nestjs/common";
import { AdminLogModule } from "../log/index.js";
import { StandingsController } from "./standings.controller.js";
import { StandingsService } from "./standings.service.js";

/** Classificação oficial da Série A e da Série B (T9). */
@Module({
  imports: [AdminLogModule],
  controllers: [StandingsController],
  providers: [StandingsService],
  exports: [StandingsService],
})
export class StandingsModule {}
