import { Module } from "@nestjs/common";
import { EntryModule } from "../../entry/index.js";
import { MarketModule } from "../../market/index.js";
import { PortfolioModule } from "../../portfolio/index.js";
import { AdminLogModule } from "../log/index.js";
import { BotsController } from "./bots.controller.js";
import { BotsService } from "./bots.service.js";

/** Bots ao vivo no admin (F14, T10 a T12). */
@Module({
  imports: [AdminLogModule, PortfolioModule, MarketModule, EntryModule],
  controllers: [BotsController],
  providers: [BotsService],
  exports: [BotsService],
})
export class BotsModule {}
