import { Module } from "@nestjs/common";
import { SeasonValuesService } from "./season-values/season-values.service.js";

/** Dividendos (valores da temporada na F7; pagamentos na F12). */
@Module({
  providers: [SeasonValuesService],
  exports: [SeasonValuesService],
})
export class DividendsModule {}
