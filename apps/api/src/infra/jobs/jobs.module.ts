import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { MarketModule } from "../../modules/market/market.module.js";
import { AccountJobs } from "./account-jobs.js";
import { MarketJobs } from "./market-jobs.js";

/** Tarefas agendadas, cada uma chamando o serviço do módulo dono (Arquitetura da Fase 1). */
@Module({
  imports: [ScheduleModule.forRoot(), MarketModule],
  providers: [AccountJobs, MarketJobs],
})
export class JobsModule {}
