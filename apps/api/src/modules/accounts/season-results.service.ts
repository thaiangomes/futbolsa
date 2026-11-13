import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../infra/db/index.js";
import { seasonResults, seasons } from "../../infra/db/schema/index.js";
import { EQUITY_BASE_CENTS } from "../portfolio/valuation/constants.js";
import { EquityAt } from "../portfolio/valuation/equity-at.js";
import { currentRowsOf } from "../rankings/snapshots.js";

const CHUNK = 1000;

/**
 * O histórico de cada jogador no encerramento da temporada (F15, T6; Conta e login, critério 15): uma linha em
 * `season_results` por jogador com carteira na temporada, inclusive o bloqueado, e sem a conta excluída (que já saiu da
 * temporada). Quem aparece no ranking anual oficial (recém-gravado na mesma transação) leva o patrimônio, a base e a
 * posição de lá; quem não aparece (o bloqueado) leva o patrimônio medido no mesmo instante pelo mesmo leitor (`EquityAt`),
 * a base de R$ 100.000,00 e a posição vazia.
 *
 * Roda na transação do encerramento, com as carteiras travadas e **antes** de zerá-las (as linhas `season_close` do
 * mesmo instante contam como "depois", mas o patrimônio sai do ranking gravado antes delas). Repetível: não regrava.
 */
@Injectable()
export class SeasonResultsService {
  async record(tx: Tx, seasonId: number, at: Date): Promise<number> {
    const [season] = await tx.db.select({ year: seasons.year }).from(seasons).where(eq(seasons.id, seasonId));
    if (!season) throw new Error(`temporada ${seasonId} não existe`);
    const annual = (await currentRowsOf(tx, seasonId, "season", String(season.year))) ?? new Map();
    const players = await tx.db.execute(sql`
      select w.id, w.user_id from futbolsa.wallets w join futbolsa.users u on u.id = w.user_id
      where w.season_id = ${seasonId} and w.owner_type = 'user' and u.status <> 'deleted'
      order by w.id`);
    const rows: Array<typeof seasonResults.$inferInsert> = [];
    const outside: Array<{ walletId: number; userId: string }> = [];
    for (const r of players.rows) {
      const walletId = Number(r.id);
      const userId = String(r.user_id);
      const row = annual.get(walletId);
      if (row) rows.push({ userId, seasonId, finalEquity: row.equity, base: row.base, position: row.position });
      else outside.push({ walletId, userId });
    }
    for (let i = 0; i < outside.length; i += CHUNK) {
      const part = outside.slice(i, i + CHUNK);
      const equities = await EquityAt.forSeason(tx, seasonId, at, { wallets: part.map((p) => p.walletId) });
      for (const p of part) {
        rows.push({ userId: p.userId, seasonId, finalEquity: equities.get(p.walletId)?.equity ?? 0, base: EQUITY_BASE_CENTS, position: null });
      }
    }
    let written = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const inserted = await tx.db.insert(seasonResults).values(rows.slice(i, i + CHUNK)).onConflictDoNothing().returning({ userId: seasonResults.userId });
      written += inserted.length;
    }
    return written;
  }
}
