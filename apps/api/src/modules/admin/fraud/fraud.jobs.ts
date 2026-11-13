import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { jobsEnabled } from "../../../infra/jobs/account-jobs.js";
import { AlertScan } from "./alert-scan.js";

/**
 * A tarefa `fraud-alert` (T21): uma varredura por minuto, sem trava. Falha vira registro no log e nunca derruba a API;
 * duas varreduras ao mesmo tempo viram uma. Desliga com `JOBS_ENABLED=false` (os testes chamam `run` direto).
 */
@Injectable()
export class FraudJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger("Trapaça");
  private running = false;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly scan: AlertScan,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    this.registry.addInterval("fraud-alert", setInterval(() => void this.run(), 60_000));
  }

  /** Uma execução da tarefa. Nunca lança. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const report = await this.scan.scan();
      if (report.created + report.grown > 0) this.logger.log(`alerta: ${report.created} casos novos, ${report.grown} casos com negócios novos`);
    } catch (error) {
      this.logger.error(`fraud-alert falhou: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
