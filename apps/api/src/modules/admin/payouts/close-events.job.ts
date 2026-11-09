import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { jobsEnabled } from "../../../infra/jobs/account-jobs.js";
import { currentSeason } from "../current-season.js";
import { MatchesEvents } from "../results/ports.js";
import { StandingsEvents } from "../standings/standings-events.js";
import { CloseEventsService, type CloseSummary } from "./close-events.service.js";

/** A passada de cada minuto pega o fechamento que ficou para trás (a margem de 2 minutos, P8). */
export const CLOSE_EVENTS_EVERY_MS = 60_000;

/**
 * Quem dispara a passada de fechamento (Plano dos dividendos e pagamentos, T3):
 * - cada `MatchesChangedEvent` (jogo importado, preenchido ou corrigido), para a temporada do evento;
 * - cada mudança da ordem da classificação oficial (importação ou correção; a conferência não muda valor);
 * - a tarefa `payouts-close`, a cada minuto e ao subir a API, para a temporada atual.
 * A tarefa desliga com `JOBS_ENABLED=false` (os testes chamam o serviço direto); as assinaturas ficam sempre.
 * Falha vira registro no log, nunca derruba a API.
 */
@Injectable()
export class CloseEventsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger("Pagamentos");

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly service: CloseEventsService,
    private readonly clock: Clock,
    @Inject(DB) private readonly db: Database,
    private readonly matchesEvents: MatchesEvents,
    private readonly standingsEvents: StandingsEvents,
  ) {}

  onApplicationBootstrap(): void {
    this.matchesEvents.subscribe((event) => this.run(event.seasonId).then(() => undefined));
    this.standingsEvents.subscribe((event) => this.run(event.seasonId).then(() => undefined));
    if (!jobsEnabled()) return;
    const tick = () => void this.runCurrent();
    this.registry.addInterval("payouts-close", setInterval(tick, CLOSE_EVENTS_EVERY_MS));
    // o fechamento perdido com a API fora se recupera ao subir
    tick();
  }

  /** A passada da temporada atual (a mais nova que não está encerrada). */
  async runCurrent(): Promise<CloseSummary | null> {
    try {
      const season = await currentSeason(this.db);
      return season ? await this.run(season.id) : null;
    } catch (error) {
      this.logger.error(`payouts-close falhou: ${(error as Error).message}`);
      return null;
    }
  }

  /** A passada de uma temporada, no instante do relógio da API. Nunca lança. */
  async run(seasonId: number): Promise<CloseSummary | null> {
    try {
      const summary = await this.service.closeEvents(seasonId, this.clock.now());
      const changed = summary.created + summary.versioned + summary.superseded;
      if (changed > 0 || summary.errors.length > 0) {
        this.logger.log(
          `fechamento da temporada ${seasonId}: ${summary.created} novos, ${summary.versioned} com versão nova, ` +
            `${summary.superseded} substituídos, ${summary.deferred} para a correção, ${summary.errors.length} com erro`,
        );
      }
      return summary;
    } catch (error) {
      this.logger.error(`fechamento da temporada ${seasonId} falhou: ${(error as Error).message}`);
      return null;
    }
  }
}
