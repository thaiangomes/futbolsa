import { Module } from "@nestjs/common";
import { JobsModule } from "../../../infra/jobs/jobs.module.js";
import { RealtimeModule } from "../../../infra/realtime/index.js";
import { PortfolioModule } from "../../portfolio/index.js";
import { RankingsModule } from "../../rankings/rankings.module.js";
import { AdminLogModule } from "../log/index.js";
import { PayoutsModule } from "../payouts/payouts.module.js";
import { ResultsModule } from "../results/results.module.js";
import { AlertScan } from "./alert-scan.js";
import { FraudCasesController } from "./cases.controller.js";
import { FraudCasesService } from "./cases.service.js";
import { FraudDecisionController } from "./decision.controller.js";
import { FraudDecisionService } from "./decision.service.js";
import { FraudJobs } from "./fraud.jobs.js";
import { FraudReportService } from "./report.service.js";

/**
 * Trapaça entre contas no admin (F14, parte 2, T20 a T27): alerta, relatório, decisão e banimento. A pasta cresce
 * tarefa a tarefa; os serviços e controladores entram aqui conforme ficam prontos. Do `ResultsModule` vêm o
 * `AdminEvents` (o `admin.pending`) e, pelo `MarketModule` que ele reexporta, o cancelamento das ordens, a anulação no
 * preço (`TradeAnnulService`) e o livro (`BookPublisher`); do `PayoutsModule`, o `cancelBuysToCover` da F12; do
 * `RankingsModule`, o pedido de recálculo; do `JobsModule`, a tarefa dos e-mails dos avisos.
 */
@Module({
  imports: [AdminLogModule, ResultsModule, PayoutsModule, PortfolioModule, RankingsModule, RealtimeModule, JobsModule],
  controllers: [FraudCasesController, FraudDecisionController],
  providers: [AlertScan, FraudCasesService, FraudReportService, FraudDecisionService, FraudJobs],
  exports: [AlertScan, FraudCasesService, FraudReportService, FraudDecisionService, FraudJobs],
})
export class FraudModule {}
