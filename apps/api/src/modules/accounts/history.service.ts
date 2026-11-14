import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, like } from "drizzle-orm";
import type { HistoryResponse } from "@futbolsa/contracts";
import { DB, type Database } from "../../infra/db/index.js";
import { rankingRows, rankingSnapshots, seasonResults, seasons, wallets } from "../../infra/db/schema/index.js";

/**
 * O histórico do jogador (`GET /me/history`; Conta e login, critérios 15 a 17): uma linha por temporada encerrada em que
 * ele tem `season_results`, com o patrimônio final, a base, a posição no anual e a posição em cada ranking mensal em
 * que apareceu. Cada ranking sai da **versão atual** (a maior), então um mês recalculado mostra o valor novo.
 */
@Injectable()
export class HistoryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async forUser(userId: string): Promise<HistoryResponse> {
    const results = await this.db
      .select({ seasonId: seasonResults.seasonId, year: seasons.year, finalEquity: seasonResults.finalEquity, base: seasonResults.base, position: seasonResults.position })
      .from(seasonResults)
      .innerJoin(seasons, eq(seasons.id, seasonResults.seasonId))
      .where(and(eq(seasonResults.userId, userId), eq(seasons.status, "closed")))
      .orderBy(desc(seasons.year));
    const out: HistoryResponse["seasons"] = [];
    for (const r of results) {
      const [wallet] = await this.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, r.seasonId), eq(wallets.userId, userId)));
      const months = wallet ? await this.monthPositions(r.seasonId, wallet.id) : [];
      out.push({ year: r.year, finalEquity: r.finalEquity, base: r.base, position: r.position, months });
    }
    return { seasons: out };
  }

  /** A posição do jogador na versão atual de cada ranking mensal da temporada (só os meses em que ele aparece). */
  private async monthPositions(seasonId: number, walletId: number): Promise<Array<{ month: string; position: number }>> {
    const heads = await this.db
      .select({ id: rankingSnapshots.id, key: rankingSnapshots.periodKey, version: rankingSnapshots.version })
      .from(rankingSnapshots)
      .where(and(eq(rankingSnapshots.seasonId, seasonId), eq(rankingSnapshots.period, "month"), like(rankingSnapshots.periodKey, "%-%")))
      .orderBy(asc(rankingSnapshots.periodKey), desc(rankingSnapshots.version));
    const current = new Map<string, number>();
    for (const h of heads) if (!current.has(h.key)) current.set(h.key, h.id);
    const out: Array<{ month: string; position: number }> = [];
    for (const [month, snapshotId] of current) {
      const [row] = await this.db
        .select({ position: rankingRows.position })
        .from(rankingRows)
        .where(and(eq(rankingRows.snapshotId, snapshotId), eq(rankingRows.walletId, walletId)));
      if (row) out.push({ month, position: row.position });
    }
    return out;
  }
}
