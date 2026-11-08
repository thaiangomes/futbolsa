import { Module } from "@nestjs/common";
import { AdminLogModule } from "../log/index.js";
import { ResultsModule } from "../results/results.module.js";
import { SuspensionController } from "./suspension.controller.js";
import { SuspensionService } from "./suspension.service.js";

/** Suspensão de um clube ou do mercado (T14). Usa o `MarketPort` do módulo de resultados. */
@Module({
  imports: [AdminLogModule, ResultsModule],
  controllers: [SuspensionController],
  providers: [SuspensionService],
  exports: [SuspensionService],
})
export class SuspensionModule {}
