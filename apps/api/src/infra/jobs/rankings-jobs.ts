import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { CloseService } from "../../modules/rankings/close.service.js";
import { LiveService } from "../../modules/rankings/live.service.js";
import { RecalcService } from "../../modules/rankings/recalc.service.js";
import { jobsEnabled } from "./account-jobs.js";

/** O passo das tarefas dos rankings: a cada minuto confere o que já devia ter sido fechado. */
export const RANKINGS_EVERY_MS = 60_000;
/** A parcial ao vivo sai a cada 10 segundos, só se algo mudou. */
export const RANKINGS_LIVE_EVERY_MS = 10_000;

/**
 * Tarefas dos rankings (dono: `rankings`). `rankings-close` fecha os meses vencidos (recupera o que ficou para trás se a
 * API estava fora às 23h59). Desligam com `JOBS_ENABLED=false`; os testes chamam `runOnce` com o relógio fixo.
 */
@Injectable()
export class RankingsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger("Tarefas");

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly close: CloseService,
    private readonly recalc: RecalcService,
    private readonly live: LiveService,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    this.every("rankings-close", () => this.close.runOnce());
    this.every("rankings-recalc", () => this.recalc.processRecalcRequests());
    this.every("rankings-live", () => this.live.publishIfChanged(), RANKINGS_LIVE_EVERY_MS);
  }

  private every(name: string, run: () => Promise<unknown>, ms = RANKINGS_EVERY_MS): void {
    const timer = setInterval(() => {
      run().catch((error: unknown) => this.logger.error(`${name} falhou: ${(error as Error).message}`));
    }, ms);
    this.registry.addInterval(name, timer);
  }
}
