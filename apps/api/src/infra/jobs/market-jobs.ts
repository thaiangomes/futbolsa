import { Injectable, Logger, Optional, type OnApplicationBootstrap } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Clock } from "../clock/index.js";
import { CloseAuctionService } from "../../modules/market/auction/close-auction.js";
import { RefreshJob, type RefreshReport } from "../../modules/market/maker/refresh.job.js";
import { jobsEnabled } from "./account-jobs.js";

/** O passo da tarefa do fim do leilão: o leilão termina no máximo 5 segundos depois do fim marcado (P10). */
export const AUCTION_CLOSE_EVERY_MS = 5_000;

/** O passo da tarefa `market-refresh`: a cada minuto, a agenda da reposição da casa (T11). */
export const MARKET_REFRESH_EVERY_MS = 60_000;

/** O que uma passada da tarefa `auction-close` fez. `skipped` quando a passada anterior ainda rodava. */
export type AuctionCloseReport =
  | { skipped: true }
  | {
      skipped: false;
      /** Os clubes cujo leilão terminou nesta passada (com ou sem negócio). */
      closed: string[];
      /** Os vencidos que não fecharam: outra transação fechou antes, ou o clube está suspenso. */
      unchanged: string[];
      /** Os que deram erro, com a mensagem: a passada seguinte tenta de novo. */
      failed: { ticker: string; error: string }[];
    };

/**
 * Tarefas do mercado (dono: `market`). `auction-close`, a cada 5 segundos: lê os clubes da temporada atual com o leilão
 * vencido e fecha cada um pelo `CloseAuctionService`, numa transação por clube. Olha o que já devia ter acontecido:
 * com a API fora no fim do leilão, ele fecha na primeira passada depois que ela volta, com o horário dessa passada.
 *
 * - Nunca duas passadas ao mesmo tempo na mesma instância: se a anterior ainda roda, a nova é pulada. Entre instâncias
 *   (e com a ordem que chega depois do fim, P10) quem protege é a trava do clube: fechar de novo não faz nada.
 * - Um clube que falha não segura os outros: o erro vai para o `Logger` e para o relatório, e a passada segue.
 * - Desliga com `JOBS_ENABLED=false` (os testes chamam `closeAuctions` com o relógio fixo).
 */
@Injectable()
export class MarketJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger("Tarefas");
  private running = false;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly clock: Clock,
    private readonly auctions: CloseAuctionService,
    /** A reposição da casa (T11). Opcional para os testes que só montam o fim do leilão. */
    @Optional() private readonly refresh?: RefreshJob,
  ) {}

  onApplicationBootstrap(): void {
    if (!jobsEnabled()) return;
    const timer = setInterval(() => {
      this.closeAuctions().catch((error: unknown) => this.logger.error(`auction-close falhou: ${(error as Error).message}`));
    }, AUCTION_CLOSE_EVERY_MS);
    this.registry.addInterval("auction-close", timer);
    const refreshTimer = setInterval(() => {
      this.refreshDue().catch((error: unknown) => this.logger.error(`market-refresh falhou: ${(error as Error).message}`));
    }, MARKET_REFRESH_EVERY_MS);
    this.registry.addInterval("market-refresh", refreshTimer);
  }

  /** Uma passada da reposição da casa: repõe os clubes atrasados pela agenda e os que têm pedido aberto. Sem sobreposição. */
  refreshDue(): Promise<RefreshReport> {
    if (!this.refresh) throw new Error("MarketJobs sem a tarefa da reposição");
    return this.refresh.runDue(this.clock.now());
  }

  /** Uma passada: fecha os leilões vencidos, um clube por vez, cada um com o relógio da hora em que fecha. */
  async closeAuctions(): Promise<AuctionCloseReport> {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      const report = { skipped: false as const, closed: [] as string[], unchanged: [] as string[], failed: [] as { ticker: string; error: string }[] };
      for (const due of await this.auctions.dueAuctions(this.clock.now())) {
        try {
          const result = await this.auctions.closeAuction(due.seasonId, due.ticker, this.clock.now());
          (result.closed ? report.closed : report.unchanged).push(due.ticker);
        } catch (error) {
          const message = (error as Error).message;
          this.logger.error(`auction-close, ${due.ticker} falhou: ${message}`);
          report.failed.push({ ticker: due.ticker, error: message });
        }
      }
      if (report.closed.length > 0) this.logger.log(`auction-close: leilão encerrado em ${report.closed.join(", ")}`);
      return report;
    } finally {
      this.running = false;
    }
  }
}
