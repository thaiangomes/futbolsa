import { Inject, Injectable } from "@nestjs/common";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, withTransaction } from "../../infra/db/index.js";
import type { Tx } from "../../infra/db/transaction.js";
import { currentSeason } from "../admin/current-season.js";
import { eq } from "drizzle-orm";
import { seasons } from "../../infra/db/schema/index.js";
import { closeAtOfMonth } from "./base.js";
import { CLOSE_GRACE_MS, closeMonth, closeSeason, monthsDue } from "./close.js";
import { currentSnapshot } from "./snapshots.js";

/** O fechamento oficial dos rankings: o mês, o ano e a tarefa que recupera o que ficou para trás (T5). */
@Injectable()
export class CloseService {
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  closeMonth(tx: Tx, args: Parameters<typeof closeMonth>[1]): Promise<boolean> {
    return closeMonth(tx, args);
  }

  closeSeason(tx: Tx, args: Parameters<typeof closeSeason>[1]) {
    return closeSeason(tx, args);
  }

  /**
   * Fecha, em ordem, todo mês da temporada cujo fechamento (`monthCloseAt`) já passou até `until`, que ainda não tem
   * ranking oficial e que não é o mês do encerramento (esse é do `closeSeason`). Cada mês mede no próprio instante de
   * fechamento, mesmo se isto roda horas depois. Devolve os meses que gravou. Quem chama de fora (a F15) passa o
   * instante dela, sem folga.
   */
  async closeMonthsDue(tx: Tx, seasonId: number, until: Date): Promise<string[]> {
    const [season] = await tx.db.select().from(seasons).where(eq(seasons.id, seasonId));
    if (!season) return [];
    const done: string[] = [];
    for (const key of monthsDue(season, until)) {
      if (await closeMonth(tx, { seasonId, monthKey: key, at: closeAtOfMonth(key), now: until })) done.push(key);
    }
    return done;
  }

  /** Uma passada da tarefa `rankings-close` (a cada minuto): um mês por transação, com a folga depois do fechamento. */
  async runOnce(now: Date = this.clock.now()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const season = await currentSeason(this.db);
      if (!season || season.status === "closed" || season.status === "preparing") return [];
      const until = new Date(now.getTime() - CLOSE_GRACE_MS);
      const done: string[] = [];
      for (const key of monthsDue(season, until)) {
        const at = closeAtOfMonth(key);
        const written = await withTransaction(
          this.db,
          async (tx) => {
            if (await currentSnapshot(tx, season.id, "month", key)) return false;
            return closeMonth(tx, { seasonId: season.id, monthKey: key, at, now });
          },
          { isolationLevel: "repeatable read" },
        );
        if (written) done.push(key);
      }
      return done;
    } finally {
      this.running = false;
    }
  }
}
