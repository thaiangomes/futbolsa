import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { NoticesService } from "../../modules/accounts/notices.service.js";
import { jobsEnabled } from "./account-jobs.js";

/**
 * A tarefa `notice-mail` (T26 da F14): a cada minuto envia os e-mails dos avisos da fila (`email_sent_at` vazio, até 5
 * tentativas). Olha o que já devia ter acontecido, então perder um horário não muda nada; falha de e-mail nunca
 * derruba a API. Quem grava um aviso acorda a tarefa com `wake()` depois do `COMMIT`.
 */
@Injectable()
export class NoticeMailJob implements OnApplicationBootstrap {
  private readonly logger = new Logger("Tarefas");
  private running = false;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly notices: NoticesService,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    this.registry.addInterval("notice-mail", setInterval(() => void this.run(), 60_000));
  }

  /** Uma execução da tarefa. Duas ao mesmo tempo viram uma. Nunca lança. */
  async run(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.notices.sendQueued();
    } catch (error) {
      this.logger.error(`notice-mail falhou: ${(error as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Acorda a tarefa fora do horário (depois do `COMMIT` da decisão). Sem esperar o resultado. */
  wake(): void {
    if (jobsEnabled()) void this.run();
  }
}
