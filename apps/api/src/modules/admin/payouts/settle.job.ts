import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { jobsEnabled } from "../../../infra/jobs/account-jobs.js";
import { SettleCreditsService, type SettlePendingSummary } from "./settle-credits.js";

/** A liquidação de cada minuto continua o crédito que ficou pela metade (a API caiu no meio dos lotes). */
export const SETTLE_EVERY_MS = 60_000;

/**
 * A tarefa de liquidação (Plano dos dividendos e pagamentos, "Aprovação em lotes", etapa 3): `payouts-settle`, a
 * cada minuto e ao subir a API, procura os eventos aprovados da temporada atual com crédito faltando e continua de
 * onde parou. A rota da aprovação também a dispara, sem esperar. Desliga com `JOBS_ENABLED=false` (os testes
 * chamam o serviço direto). Falha vira registro no log, nunca derruba a API. Pega também os complementos e
 * estornos da correção (T7), inclusive os das carteiras que não cobrem o estorno, pelo mesmo `settlePending`.
 */
@Injectable()
export class SettleJob implements OnApplicationBootstrap {
  private readonly logger = new Logger("Pagamentos");

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly service: SettleCreditsService,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    const tick = () => void this.run();
    this.registry.addInterval("payouts-settle", setInterval(tick, SETTLE_EVERY_MS));
    // o crédito interrompido com a API fora continua ao subir
    tick();
  }

  /** Uma execução da tarefa. Nunca lança. */
  async run(): Promise<SettlePendingSummary | null> {
    try {
      const summary = await this.service.settlePending();
      if (summary.credited > 0 || summary.errors.length > 0) {
        this.logger.log(`liquidação: ${summary.events} eventos, ${summary.credited} créditos, ${summary.errors.length} com erro`);
      }
      return summary;
    } catch (error) {
      this.logger.error(`payouts-settle falhou: ${(error as Error).message}`);
      return null;
    }
  }
}
