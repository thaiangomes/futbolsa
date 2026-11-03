import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AccountJobs } from "./account-jobs.js";

/** Tarefas agendadas, cada uma chamando o serviço do módulo dono (Arquitetura da Fase 1). */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [AccountJobs],
})
export class JobsModule {}
