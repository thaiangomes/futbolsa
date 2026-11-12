import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, withTransaction } from "../../../infra/db/index.js";
import { equityDaily, wallets } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { EquityAt } from "../valuation/equity-at.js";
import { brasiliaDay, closedDays, dayPointAt } from "./days.js";

/** Carteiras por transação: o patrimônio de cada lote sai de uma foto só do banco. */
export const DAILY_BATCH = 500;

export interface DailyReport {
  /** Linhas gravadas nesta passada. */
  written: number;
  /** Os dias (de Brasília) em que gravou. */
  days: string[];
}

/**
 * O patrimônio diário (P6): `equity_daily.day = D` guarda o patrimônio às 24h de Brasília de D. A tarefa olha o que já
 * devia ter sido gravado (dias fechados há mais de 30 segundos, de jogadores e bots, nunca a tesouraria) e grava o que
 * falta, do dia mais antigo para o mais novo, em lotes. O valor sai do histórico em T (`EquityAt`), então atrasar não muda
 * o resultado e a API fora por dias recupera tudo ao voltar. Gravar duas vezes não duplica. A correção de pagamento não
 * regrava dias passados (critério 44): o ranking é quem recalcula.
 */
@Injectable()
export class EquityDailyService {
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async runOnce(now: Date = this.clock.now()): Promise<DailyReport> {
    const report: DailyReport = { written: 0, days: [] };
    if (this.running) return report;
    this.running = true;
    try {
      const season = await currentSeason(this.db);
      if (!season || season.status === "closed" || season.status === "preparing") return report;
      const [first] = await this.db
        .select({ at: sql<Date>`min(${wallets.enteredAt})` })
        .from(wallets)
        .where(and(eq(wallets.seasonId, season.id), sql`${wallets.ownerType} <> 'treasury'`));
      if (!first?.at) return report;
      const all = closedDays(new Date(first.at).getTime(), now.getTime());
      if (all.length === 0) return report;
      // uma consulta só diz quais dias ainda têm carteira sem a linha (sem nada faltando, acaba aqui)
      const pending = await this.db.execute(sql`
        select to_char(d, 'YYYY-MM-DD') as day from generate_series(${brasiliaDay(all[0]!)}::date, ${brasiliaDay(all[all.length - 1]!)}::date, interval '1 day') d
        where exists (select 1 from futbolsa.wallets w where w.season_id = ${season.id} and w.owner_type <> 'treasury'
          and w.entered_at <= (d + interval '1 day') at time zone 'America/Sao_Paulo'
          and not exists (select 1 from futbolsa.equity_daily e where e.wallet_id = w.id and e.day = d::date))`);
      const missingDays = new Set(pending.rows.map((r) => String(r.day)));
      for (const start of all) {
        if (!missingDays.has(brasiliaDay(start))) continue;
        const day = brasiliaDay(start);
        const at = new Date(dayPointAt(start));
        // as carteiras que já existiam no fim do dia e ainda não têm a linha dele
        const missing = await this.db.execute(sql`
          select w.id from futbolsa.wallets w
          where w.season_id = ${season.id} and w.owner_type <> 'treasury' and w.entered_at <= ${at.toISOString()}::timestamptz
            and not exists (select 1 from futbolsa.equity_daily d where d.wallet_id = w.id and d.day = ${day}::date)
          order by w.id`);
        const ids = missing.rows.map((r) => Number(r.id));
        for (let i = 0; i < ids.length; i += DAILY_BATCH) {
          const batch = ids.slice(i, i + DAILY_BATCH);
          const written = await withTransaction(
            this.db,
            async (tx) => {
              const equities = await EquityAt.forSeason(tx, season.id, at, { wallets: batch });
              const rows = [...equities.values()].map((e) => ({ walletId: e.walletId, day, equity: e.equity }));
              if (rows.length === 0) return 0;
              const inserted = await tx.db.insert(equityDaily).values(rows).onConflictDoNothing().returning({ walletId: equityDaily.walletId });
              return inserted.length;
            },
            { isolationLevel: "repeatable read" },
          );
          report.written += written;
          if (written > 0 && !report.days.includes(day)) report.days.push(day);
        }
      }
      return report;
    } finally {
      this.running = false;
    }
  }
}
