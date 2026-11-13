import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { jobsEnabled } from "../../../infra/jobs/account-jobs.js";
import { BotRunner, BotRunnerSettings } from "./runner.js";

/**
 * A tarefa `bots-run` (T12 da F14): uma rodada a cada `BOT_TICK_MINUTES` (padrão 15). Falha vira registro no log, nunca
 * derruba a API; duas rodadas ao mesmo tempo viram uma só (o `BotRunner` pula a segunda). Desliga com `JOBS_ENABLED=false`
 * (os testes chamam `runOnce` direto, com o relógio fixo).
 */
@Injectable()
export class BotsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger("Bots");

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly runner: BotRunner,
    private readonly settings: BotRunnerSettings,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    const ms = this.settings.config.tickMinutes * 60_000;
    this.registry.addInterval("bots-run", setInterval(() => void this.run(), ms));
  }

  /** Uma execução da tarefa. Nunca lança. */
  async run(): Promise<void> {
    try {
      const report = await this.runner.runOnce();
      if (!report.skipped && (report.placed > 0 || report.bids > 0 || report.swept > 0)) {
        this.logger.log(`rodada (${report.status}): ${report.acted} bots agiram, ${report.placed} ordens, ${report.bids} ofertas, ${report.swept} varridas, recusas ${JSON.stringify(report.refused)}`);
      }
    } catch (error) {
      this.logger.error(`bots-run falhou: ${(error as Error).message}`);
    }
  }
}
