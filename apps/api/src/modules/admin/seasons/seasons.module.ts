import { Module } from "@nestjs/common";
import { DividendsModule } from "../../dividends/dividends.module.js";
import { AdminLogModule } from "../log/index.js";
import { ClubsController } from "./clubs.controller.js";
import { RulesController } from "./rules.controller.js";
import { RulesService } from "./rules.service.js";
import { PublicSeasonController, SeasonsController } from "./seasons.controller.js";
import { SeasonsService } from "./seasons.service.js";

/** Preparar a temporada, valores das ligas e tabelas das copas (T11 a T13). */
@Module({
  imports: [AdminLogModule, DividendsModule],
  controllers: [PublicSeasonController, SeasonsController, RulesController, ClubsController],
  providers: [SeasonsService, RulesService],
  exports: [SeasonsService, RulesService],
})
export class SeasonsModule {}
