import { Module } from "@nestjs/common";
import { EntryModule } from "../../entry/index.js";
import { IpoModule } from "../../ipo/index.js";
import { MarketModule } from "../../market/index.js";
import { PortfolioModule } from "../../portfolio/index.js";
import { AdminLogModule } from "../log/index.js";
import { BotsController } from "./bots.controller.js";
import { BotsJob } from "./bots.jobs.js";
import { BotsService } from "./bots.service.js";
import { BotSnapshotService } from "./market-snapshot.js";
import { AttentionClubs, noAttention, noPartialScores, PartialScores } from "./partial-scores.js";
import { BotRunner, BotRunnerSettings, botRunnerConfigFromEnv } from "./runner.js";

/** Bots ao vivo no admin (F14, T10 a T12): ligar e desligar, a visão de mercado e a tarefa que os faz agir. */
@Module({
  imports: [AdminLogModule, PortfolioModule, MarketModule, EntryModule, IpoModule],
  controllers: [BotsController],
  providers: [
    BotsService,
    BotSnapshotService,
    BotRunner,
    BotsJob,
    { provide: PartialScores, useValue: noPartialScores },
    { provide: AttentionClubs, useValue: noAttention },
    { provide: BotRunnerSettings, useFactory: () => ({ config: botRunnerConfigFromEnv() }) },
  ],
  exports: [BotsService, BotRunner],
})
export class BotsModule {}
