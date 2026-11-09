import { Module } from "@nestjs/common";
import { AdminLogModule } from "../log/index.js";
import { StandingsEvents } from "./standings-events.js";
import { StandingsController } from "./standings.controller.js";
import { StandingsService } from "./standings.service.js";

/** Classificação oficial da Série A e da Série B (T9). A F12 assina o `StandingsEvents`. */
@Module({
  imports: [AdminLogModule],
  controllers: [StandingsController],
  providers: [StandingsService, StandingsEvents],
  exports: [StandingsService, StandingsEvents],
})
export class StandingsModule {}
