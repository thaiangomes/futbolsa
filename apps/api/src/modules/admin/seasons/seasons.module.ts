import { Module } from "@nestjs/common";
import { DividendsModule } from "../../dividends/dividends.module.js";
import { AdminLogModule } from "../log/index.js";
import { PublicSeasonController, SeasonsController } from "./seasons.controller.js";
import { SeasonsService } from "./seasons.service.js";

/** Preparar a temporada, regras e copas (T11 a T13). */
@Module({
  imports: [AdminLogModule, DividendsModule],
  controllers: [PublicSeasonController, SeasonsController],
  providers: [SeasonsService],
  exports: [SeasonsService],
})
export class SeasonsModule {}
