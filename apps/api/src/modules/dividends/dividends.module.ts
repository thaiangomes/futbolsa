import { Module } from "@nestjs/common";
import { ClubValueController } from "./club-value/club-value.controller.js";
import { ClubValueService } from "./club-value/club-value.service.js";
import { ProjectionsController } from "./club-value/projections.controller.js";
import { ProjectionsService } from "./club-value/projections.service.js";
import { SeasonValuesService } from "./season-values/season-values.service.js";

/** Dividendos (valores da temporada na F7; pagamentos na F12; o simulador "Quanto vale para você" na T12). */
@Module({
  controllers: [ClubValueController, ProjectionsController],
  providers: [SeasonValuesService, ClubValueService, ProjectionsService],
  exports: [SeasonValuesService],
})
export class DividendsModule {}
