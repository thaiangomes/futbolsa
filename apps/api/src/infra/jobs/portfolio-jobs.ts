import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { EquityDailyService } from "../../modules/portfolio/daily/equity-daily.service.js";
import { SnapshotService } from "../../modules/portfolio/snapshots/snapshot.service.js";
import { jobsEnabled } from "./account-jobs.js";

/** O passo das tarefas de recuperação da carteira: a cada 5 minutos confere o que já devia ter sido gravado (P6). */
export const PORTFOLIO_EVERY_MS = 5 * 60_000;

/**
 * Tarefas da carteira (dono: `portfolio`). `equity-daily` grava o patrimônio dos dias fechados e `portfolio-snapshots`
 * grava a foto dos meses fechados; as duas olham o que já devia ter acontecido, então perder um horário não muda nada, e
 * gravar duas vezes não duplica. Desligam com `JOBS_ENABLED=false` (os testes chamam `runOnce` com o relógio fixo).
 */
@Injectable()
export class PortfolioJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger("Tarefas");

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly daily: EquityDailyService,
    private readonly snapshots: SnapshotService,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    this.every("equity-daily", () => this.daily.runOnce());
    this.every("portfolio-snapshots", () => this.snapshots.runOnce());
  }

  private every(name: string, run: () => Promise<unknown>): void {
    const timer = setInterval(() => {
      run().catch((error: unknown) => this.logger.error(`${name} falhou: ${(error as Error).message}`));
    }, PORTFOLIO_EVERY_MS);
    this.registry.addInterval(name, timer);
  }
}
