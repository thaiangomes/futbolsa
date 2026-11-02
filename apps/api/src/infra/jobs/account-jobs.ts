import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { AccountDeletionService } from "../../modules/accounts/deletion.service.js";

/** As tarefas agendadas desligam com `JOBS_ENABLED=false` (os testes chamam os serviços direto). */
export const jobsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.JOBS_ENABLED !== "false";

/**
 * Tarefas da exclusão da conta (dono: `accounts`). Cada uma olha o que já devia ter acontecido,
 * então perder um horário não muda nada:
 * - `account-closeout`, a cada minuto: encerra as carteiras que esperavam a liquidação do IPO;
 * - `identity-cleanup`, a cada hora: apaga no login as identidades que falharam na hora da exclusão.
 */
@Injectable()
export class AccountJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger("Tarefas");

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly deletion: AccountDeletionService,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    this.every("account-closeout", 60_000, () => this.deletion.closeoutPending());
    this.every("identity-cleanup", 3_600_000, () => this.deletion.purgeIdentities());
  }

  private every(name: string, ms: number, run: () => Promise<number>): void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      run()
        .then((n) => n > 0 && this.logger.log(`${name}: ${n}`))
        .catch((error: unknown) => this.logger.error(`${name} falhou: ${(error as Error).message}`))
        .finally(() => (running = false));
    }, ms);
    this.registry.addInterval(name, timer);
  }
}
