import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { findFraudAlerts, FRAUD_ALERT_WINDOW_MS, type FraudAlert, type FraudTrade } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { fraudCases, fraudCaseTrades } from "../../../infra/db/schema/index.js";
import { suspectTrades } from "../../market/index.js";
import { currentSeason } from "../current-season.js";
import { AdminEvents } from "../events.js";

export interface AlertScanReport {
  /** Casos de alerta novos. */
  created: number;
  /** Casos abertos que ganharam negócios. */
  grown: number;
}

/**
 * A tarefa do alerta de trapaça (T21): a cada minuto, **sem trava**, lê os negócios suspeitos dos últimos 7 dias, tira
 * os que já estão em caso decidido ("depois da decisão, só negócio novo conta", proposta 15) e chama o `findFraudAlerts`
 * do motor. O que achar cria o caso de alerta do par e do clube ou entra no caso aberto dele. Não guarda progresso: é
 * o "o que já devia ter acontecido" da arquitetura, e a API fora do ar não perde nada. Nada disto roda dentro da
 * transação de uma ordem (proposta 13). Quem joga não vê nada: as tabelas só são lidas em `/admin`.
 */
@Injectable()
export class AlertScan {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly events: AdminEvents,
  ) {}

  async scan(): Promise<AlertScanReport> {
    const now = this.clock.now();
    const season = await currentSeason(this.db);
    if (!season) return { created: 0, grown: 0 };

    const from = new Date(now.getTime() - FRAUD_ALERT_WINDOW_MS);
    const rows = await suspectTrades(this.db, { seasonId: season.id, from, to: now });
    if (rows.length === 0) return { created: 0, grown: 0 };

    const decided = await this.decidedTradeIds(season.id, rows.map((r) => r.id));
    const candidates: FraudTrade[] = rows
      .filter((r) => !decided.has(r.id))
      .map((r) => ({
        id: r.id,
        at: r.at.getTime(),
        clubId: r.clubId,
        buyerWallet: r.buyerWalletId,
        sellerWallet: r.sellerWalletId,
        quantity: r.quantity,
        price: r.price,
        priceBefore: r.priceBefore,
        withHouse: false,
      }));

    const report: AlertScanReport = { created: 0, grown: 0 };
    for (const alert of findFraudAlerts(candidates)) {
      const result = await this.upsert(season.id, alert, now);
      if (result === "created") report.created += 1;
      else if (result === "grown") report.grown += 1;
    }
    if (report.created + report.grown > 0) await this.events.publishPending();
    return report;
  }

  /** Dos negócios dados, os que estão num caso já decidido (confirmado ou descartado). */
  private async decidedTradeIds(seasonId: number, ids: number[]): Promise<Set<number>> {
    const found = await this.db
      .select({ tradeId: fraudCaseTrades.tradeId })
      .from(fraudCaseTrades)
      .innerJoin(fraudCases, eq(fraudCases.id, fraudCaseTrades.caseId))
      .where(and(eq(fraudCases.seasonId, seasonId), inArray(fraudCaseTrades.tradeId, ids), sql`${fraudCases.status} <> 'open'`));
    return new Set(found.map((f) => f.tradeId));
  }

  /** Cria o caso do par ou entra no aberto; repetir a tarefa não duplica nada. */
  private async upsert(seasonId: number, alert: FraudAlert, now: Date): Promise<"created" | "grown" | "same"> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(fraudCases)
        .values({
          seasonId,
          origin: "alert",
          status: "open",
          walletLow: alert.walletLow,
          walletHigh: alert.walletHigh,
          clubId: alert.clubId,
          periodFrom: new Date(alert.firstAt),
          periodTo: new Date(alert.lastAt),
          openedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: fraudCases.id });
      let caseId = inserted[0]?.id;
      const created = caseId !== undefined;
      if (caseId === undefined) {
        const [open] = await tx
          .select({ id: fraudCases.id })
          .from(fraudCases)
          .where(
            and(
              eq(fraudCases.seasonId, seasonId),
              eq(fraudCases.origin, "alert"),
              eq(fraudCases.status, "open"),
              eq(fraudCases.clubId, alert.clubId),
              eq(fraudCases.walletLow, alert.walletLow),
              eq(fraudCases.walletHigh, alert.walletHigh),
            ),
          );
        // o caso foi decidido entre a consulta e a gravação: a próxima rodada vê o estado novo
        if (!open) return "same";
        caseId = open.id;
      }
      const added = await tx
        .insert(fraudCaseTrades)
        .values(alert.tradeIds.map((tradeId) => ({ caseId: caseId!, tradeId, suspicious: true })))
        .onConflictDoNothing()
        .returning({ tradeId: fraudCaseTrades.tradeId });
      if (!created && added.length > 0) {
        await tx
          .update(fraudCases)
          .set({
            periodFrom: sql`least(${fraudCases.periodFrom}, ${new Date(alert.firstAt).toISOString()}::timestamptz)`,
            periodTo: sql`greatest(${fraudCases.periodTo}, ${new Date(alert.lastAt).toISOString()}::timestamptz)`,
          })
          .where(and(eq(fraudCases.id, caseId), eq(fraudCases.status, "open")));
      }
      return created ? "created" : added.length > 0 ? "grown" : "same";
    });
  }
}
