import { Inject, Injectable, Logger } from "@nestjs/common";
import { count, eq } from "drizzle-orm";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockSeason, withTransaction } from "../../../infra/db/index.js";
import { ipoResults, seasonClubs, seasons } from "../../../infra/db/schema/index.js";
import { EventBus } from "../../../infra/realtime/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { RefreshJob, type RefreshReport } from "../maker/refresh.job.js";

/** O que uma passada da abertura da negociação fez. */
export type OpeningResult =
  | { opened: true; at: Date; refresh: RefreshReport }
  | { opened: false; reason: "no_season" | "not_closed" | "not_due" | "not_settled" };

/**
 * A abertura da negociação (T12 do Plano do livro de ofertas e formador; critério 21): às 10h de Brasília do dia
 * seguinte ao fechamento do IPO (`trading_opens_at`), e com a liquidação de TODOS os clubes listados feita (`ipo_results`
 * de cada um, como o Plano do IPO define), a temporada passa de `ipo_closed` para `trading`, a casa cota todos os clubes
 * pela primeira vez (o preço exibido é o de corte do IPO, que a F8 gravou em `last_price`) e o `season.status` sai uma vez.
 *
 * - **Liquidação atrasada adia a abertura** até ela terminar: a tarefa de cada minuto tenta de novo.
 * - **Repetível:** a transação trava a temporada e olha o estado de novo; a segunda passada vê `trading` e não faz nada,
 *   então o aviso sai uma vez só e a casa não repõe duas vezes. Se a API caiu entre a troca de estado e a primeira
 *   reposição, a tarefa de reposição (T11) cota os clubes na passada seguinte, porque nunca foram repostos.
 */
@Injectable()
export class OpeningJob {
  private readonly logger = new Logger("Abertura");
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly bus: EventBus,
    private readonly refresh: RefreshJob,
    private readonly clock: Clock,
  ) {}

  async runOnce(now: Date = this.clock.now()): Promise<OpeningResult> {
    if (this.running) return { opened: false, reason: "not_due" };
    this.running = true;
    try {
      const season = await currentSeason(this.db);
      if (!season) return { opened: false, reason: "no_season" };
      if (season.status !== "ipo_closed") return { opened: false, reason: "not_closed" };
      if (season.tradingOpensAt === null || now < season.tradingOpensAt) return { opened: false, reason: "not_due" };

      const opened = await withTransaction(this.db, async (tx) => {
        // trava a temporada e olha de novo: duas passadas ao mesmo tempo abrem uma vez só
        const locked = await lockSeason(tx, season.id, "update");
        if (locked.status !== "ipo_closed") return null;
        const [{ listed }] = (await tx.db.select({ listed: count() }).from(seasonClubs).where(eq(seasonClubs.seasonId, season.id))) as [{ listed: number }];
        const [{ settled }] = (await tx.db.select({ settled: count() }).from(ipoResults).where(eq(ipoResults.seasonId, season.id))) as [{ settled: number }];
        if (listed === 0 || settled < listed) return "not_settled" as const;
        const [row] = await tx.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, season.id)).returning();
        const data = {
          seasonId: row!.id,
          status: row!.status as "trading",
          ipoClosesAt: row!.ipoClosesAt?.toISOString() ?? null,
          tradingOpensAt: row!.tradingOpensAt?.toISOString() ?? null,
        };
        tx.afterCommit(() => this.bus.publish("season", "season.status", data));
        return "opened" as const;
      });
      if (opened === "not_settled") return { opened: false, reason: "not_settled" };
      if (opened === null) return { opened: false, reason: "not_closed" };
      // a primeira cotação da casa em todos os clubes (ninguém foi reposto ainda, então a agenda manda repor todos)
      const refresh = await this.refresh.runDue(now);
      this.logger.log(`negociação aberta; reposição inicial: ${refresh.refreshed.length} clubes`);
      return { opened: true, at: now, refresh };
    } finally {
      this.running = false;
    }
  }
}
