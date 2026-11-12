import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MarketModule } from "../../modules/market/market.module.js";
import { PortfolioModule } from "../../modules/portfolio/portfolio.module.js";
import { AccountJobs } from "./account-jobs.js";
import { MarketJobs } from "./market-jobs.js";
import { PortfolioJobs } from "./portfolio-jobs.js";

/** Tarefas agendadas, cada uma chamando o serviço do módulo dono (Arquitetura da Fase 1). */
@Module({
  imports: [ScheduleModule.forRoot(), MarketModule, PortfolioModule],
  providers: [AccountJobs, MarketJobs, PortfolioJobs],
})
export class JobsModule {}
