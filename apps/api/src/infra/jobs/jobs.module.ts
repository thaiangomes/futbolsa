import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MarketModule } from "../../modules/market/market.module.js";
import { RankingsModule } from "../../modules/rankings/rankings.module.js";
import { PortfolioModule } from "../../modules/portfolio/portfolio.module.js";
import { AccountJobs } from "./account-jobs.js";
import { NoticeMailJob } from "./notice-mail.js";
import { MarketJobs } from "./market-jobs.js";
import { PortfolioJobs } from "./portfolio-jobs.js";
import { RankingsJobs } from "./rankings-jobs.js";

/** Tarefas agendadas, cada uma chamando o serviço do módulo dono (Arquitetura da Fase 1). */
@Module({
  imports: [ScheduleModule.forRoot(), MarketModule, PortfolioModule, RankingsModule],
  providers: [AccountJobs, NoticeMailJob, MarketJobs, PortfolioJobs, RankingsJobs],
})
export class JobsModule {}
