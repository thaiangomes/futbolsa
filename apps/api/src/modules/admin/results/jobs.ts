import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { jobsEnabled } from "../../../infra/jobs/account-jobs.js";
import { AdminEvents } from "../events.js";
import { ImportRunner } from "./import-runner.js";

/**
 * As tarefas agendadas dos resultados (Admin, critérios 5 e 6; dono: `admin`):
 * - `results-calendar`, a cada hora: importa o calendário das competições cuja última importação tem mais de 24 horas
 *   (uma vez por dia, e ao subir a API, se o horário foi perdido);
 * - `results-scores`, a cada 15 minutos: importa os placares das competições com jogo devido, e depois a classificação.
 * Desligam com `JOBS_ENABLED=false` (os testes chamam o `ImportRunner` direto, com o relógio fixo).
 */
@Injectable()
export class ResultsJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger("Tarefas");

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly runner: ImportRunner,
    private readonly events: AdminEvents,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    this.every("results-calendar", 3_600_000, () => this.runner.runCalendarIfStale(), true);
    this.every("results-scores", 15 * 60_000, async () => {
      const reports = await this.runner.runScores();
      // um jogo vira pendência 6 horas depois do fim previsto, sem ninguém mexer nele: o aviso sai a cada rodada
      await this.events.publishPending();
      return reports;
    }, false);
  }

  private every(name: string, ms: number, run: () => Promise<Array<{ error: string | null }>>, onBoot: boolean): void {
    const tick = () =>
      run()
        .then((reports) => reports.length > 0 && this.logger.log(`${name}: ${reports.length} importações, ${reports.filter((r) => r.error).length} com erro`))
        .catch((error: unknown) => this.logger.error(`${name} falhou: ${(error as Error).message}`));
    this.registry.addInterval(name, setInterval(tick, ms));
    // A tarefa que perdeu o horário se recupera ao subir a API.
    if (onBoot) void tick();
  }
}
