import { Module } from "@nestjs/common";
import { AdminLogModule } from "../log/index.js";
import { ResultsModule } from "../results/results.module.js";
import { AlertScan } from "./alert-scan.js";
import { FraudCasesController } from "./cases.controller.js";
import { FraudCasesService } from "./cases.service.js";
import { FraudJobs } from "./fraud.jobs.js";

/**
 * Trapaça entre contas no admin (F14, parte 2, T20 a T27): alerta, relatório, decisão e banimento. A pasta cresce
 * tarefa a tarefa; os serviços e controladores entram aqui conforme ficam prontos. Do `ResultsModule` vem o
 * `AdminEvents` (o `admin.pending`).
 */
@Module({
  imports: [AdminLogModule, ResultsModule],
  controllers: [FraudCasesController],
  providers: [AlertScan, FraudCasesService, FraudJobs],
  exports: [AlertScan, FraudCasesService, FraudJobs],
})
export class FraudModule {}
