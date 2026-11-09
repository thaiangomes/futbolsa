import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Clock } from "../../infra/clock/index.js";
import { jobsEnabled } from "../../infra/jobs/account-jobs.js";
import { IpoClosingService, type IpoCloseResult } from "./closing.service.js";
import { IpoOpeningService, type IpoOpenResult } from "./opening.service.js";
import { IpoSettlementService, type IpoSettleResult } from "./settlement.service.js";

/** Uma etapa que deu erro na passada: o texto fica no relatório e no log, e a próxima passada tenta de novo. */
export interface IpoStepError {
  status: "error";
  error: string;
}

/** O que uma passada da tarefa fez, etapa por etapa. `skipped` quando outra passada ainda estava rodando. */
export type IpoJobReport =
  | { skipped: true }
  | { skipped: false; opening: IpoOpenResult | IpoStepError; closing: IpoCloseResult | IpoStepError; settlement: IpoSettleResult | IpoStepError };

/**
 * A tarefa agendada do IPO (IPO por bookbuilding, critério 1; Admin, critério 19): a cada minuto, com o
 * relógio da API, abre as ofertas na data, fecha o período e liquida os clubes, nessa ordem, sem nenhuma
 * ação do admin. Cada etapa olha o que já devia ter acontecido, então perder um minuto (ou a API ficar fora
 * do ar entre o fechamento e a liquidação) não muda nada: a primeira passada depois faz tudo o que falta.
 *
 * - Nunca duas passadas ao mesmo tempo na mesma instância: se a anterior ainda roda, a nova é pulada. Entre
 *   instâncias quem protege são as travas dos serviços (cada um é repetível e serializa pela temporada e
 *   pelo clube).
 * - Erro numa etapa não impede as seguintes nem a passada do minuto seguinte: vai para o `Logger` e para o
 *   relatório, e a etapa tenta de novo. Por isso a liquidação roda mesmo se a abertura ou o fechamento falhou.
 * - Desliga com `JOBS_ENABLED=false` (os testes chamam `runOnce` com o relógio fixo).
 */
@Injectable()
export class IpoJob implements OnApplicationBootstrap {
  private readonly logger = new Logger("Tarefas");
  private running = false;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly clock: Clock,
    private readonly opening: IpoOpeningService,
    private readonly closing: IpoClosingService,
    private readonly settlement: IpoSettlementService,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    const timer = setInterval(() => {
      this.runOnce().catch((error: unknown) => this.logger.error(`ipo falhou: ${(error as Error).message}`));
    }, 60_000);
    this.registry.addInterval("ipo", timer);
  }

  /** Uma passada: abrir, fechar e liquidar com o relógio da API. */
  async runOnce(): Promise<IpoJobReport> {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      const opening = await this.step("abertura", () => this.opening.openIfDue(this.clock.now()));
      const closing = await this.step("fechamento", () => this.closing.closeIfDue(this.clock.now()));
      const settlement = await this.step("liquidação", () => this.settlement.settleDue(this.clock.now()));
      if (opening.status === "opened") this.logger.log(`ipo: ofertas abertas (${opening.credited} contas creditadas)`);
      if (closing.status === "closed") this.logger.log("ipo: período de ofertas fechado");
      if (settlement.status === "ran" && settlement.settled.length > 0) {
        this.logger.log(`ipo: ${settlement.settled.length} clubes liquidados, ${settlement.pending} pendentes`);
      }
      return { skipped: false, opening, closing, settlement };
    } finally {
      this.running = false;
    }
  }

  private async step<T>(name: string, run: () => Promise<T>): Promise<T | IpoStepError> {
    try {
      return await run();
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`ipo, ${name} falhou: ${message}`);
      return { status: "error", error: message };
    }
  }
}
