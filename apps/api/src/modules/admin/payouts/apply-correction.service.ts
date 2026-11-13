import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type ApplyCorrectionBody, type ApplyCorrectionResponse, type CorrectionPreview } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockPayoutEvents, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { payoutEvents, seasons } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason, type SeasonRow } from "../current-season.js";
import { AdminLogService } from "../log/admin-log.service.js";
import { MarketPort } from "../results/ports.js";
import { roundAndPhase, storedCompetition } from "./close-events.service.js";
import { PayoutEvents } from "./events.js";
import { type CorrectionPlan, CorrectionPlanService } from "./correction-plan.js";
import { copyHoldings, writeHoldings } from "./holdings.js";
import { RankingsPort } from "./ports.js";
import { settlingEventIds } from "./settlement.js";

/** O plano que o admin viu não é mais o que os resultados dão (ou outra correção passou na frente). */
class StaleCorrection extends Error {
  constructor() {
    super("correction_stale");
    this.name = "StaleCorrection";
  }
}

/**
 * Aplicar a correção depois de pago (Plano dos dividendos e pagamentos, "Aplicar a correção", etapa 1; Admin, "Correção
 * depois de pago", critérios 12, 13, 17 e 33). Uma transação:
 *
 * 1. a temporada compartilhada (o encerramento espera; encerrada, `season_closed`);
 * 2. recalcula o plano e compara o código; diferente, `correction_stale` com a prévia nova (alguém mudou um resultado,
 *    ou outra correção passou na frente);
 * 3. trava as linhas das versões vigentes em ordem de id (`FOR UPDATE`: os lotes de crédito, com `FOR SHARE`, acabam
 *    antes ou esperam) e confere que continuam aprovadas e liquidadas;
 * 4. as antigas viram `superseded` e as novas entram já `approved` (autor e horário da correção), cada uma com a foto
 *    (copiada da antiga quando o fechamento não mudou, a tirada pelo plano quando mudou ou o evento é novo);
 * 5. o registro do admin com o motivo (obrigatório) e o resumo da prévia; o pedido de reposição do formador
 *    (`correction`) para os clubes afetados; o aviso aos rankings com os fechamentos antigos e novos.
 *
 * Depois do `COMMIT`, o `wake()` dos rankings. Os estornos e complementos saem pela liquidação (`SettleCreditsService`,
 * disparada pela rota e retomada pela tarefa de cada minuto), que lê nas versões novas o líquido de cada carteira.
 */
@Injectable()
export class ApplyCorrectionService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly plans: CorrectionPlanService,
    private readonly adminLog: AdminLogService,
    private readonly market: MarketPort,
    private readonly rankings: RankingsPort,
    private readonly clock: Clock,
    @Optional() private readonly events?: PayoutEvents,
  ) {}

  async apply(actorId: string, body: ApplyCorrectionBody): Promise<ApplyCorrectionResponse> {
    const season = await this.season();
    try {
      return await withTransaction(this.db, (tx) => this.applyTx(tx, actorId, season.id, body));
    } catch (error) {
      if (!(error instanceof StaleCorrection)) throw error;
      // a prévia nova, fora da transação desfeita; se ainda não dá para calcular (um pagamento liquidando), vai sem ela
      let preview: CorrectionPreview | undefined;
      try {
        preview = (await this.plans.plan(this.db, season.id, this.clock.now())).preview;
      } catch {
        preview = undefined;
      }
      throw new DomainError("correction_stale", 409, ADMIN_ERROR_MESSAGES.correction_stale, undefined, preview ? { preview } : undefined);
    }
  }

  /** A temporada atual; sem nenhuma aberta, a recusa da mais nova encerrada (critério 18) ou `no_season`. */
  private async season(): Promise<SeasonRow> {
    const current = await currentSeason(this.db);
    if (current) return current;
    const [latest] = await this.db.select({ status: seasons.status }).from(seasons).orderBy(desc(seasons.year)).limit(1);
    if (latest?.status === "closed") throw new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);
    throw new DomainError("no_season", 409, ADMIN_ERROR_MESSAGES.no_season);
  }

  private async applyTx(tx: Tx, actorId: string, seasonId: number, body: ApplyCorrectionBody): Promise<ApplyCorrectionResponse> {
    const now = this.clock.now();
    const season = await lockSeason(tx, seasonId, "share");
    if (season.status === "closed") throw new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);

    let plan: CorrectionPlan;
    try {
      plan = await this.plans.plan(tx, seasonId, now);
    } catch (error) {
      // um pagamento começou a liquidar depois da prévia (outra correção aplicada agora mesmo): a prévia é velha
      if (error instanceof DomainError && error.code === "payout_settling") throw new StaleCorrection();
      throw error;
    }
    if (plan.planCode !== body.planCode) throw new StaleCorrection();
    const response: ApplyCorrectionResponse = { planCode: plan.planCode, events: [], wallets: plan.preview.wallets };
    if (plan.events.length === 0) return response;

    // as versões vigentes, em ordem de id: quem chegou antes (outra correção) já as substituiu
    const currentIds = plan.events.flatMap((e) => (e.current ? [e.current.id] : []));
    const locked = await lockPayoutEvents(tx, currentIds, "update");
    if (locked.some((e) => e.status !== "approved")) throw new StaleCorrection();
    if ((await settlingEventIds(tx, seasonId, currentIds)).length > 0) {
      throw new DomainError("payout_settling", 409, ADMIN_ERROR_MESSAGES.payout_settling);
    }

    if (currentIds.length > 0) {
      await tx.db
        .update(payoutEvents)
        .set({ status: "superseded" })
        .where(and(inArray(payoutEvents.id, currentIds), eq(payoutEvents.status, "approved")));
    }
    for (const planned of plan.events) {
      const version = (await this.lastVersion(tx, seasonId, planned.clubId, planned.key)) + 1;
      const [row] = await tx.db
        .insert(payoutEvents)
        .values({
          seasonId,
          clubId: planned.clubId,
          eventKey: planned.key,
          kind: planned.next.kind,
          reason: planned.next.reason,
          competition: storedCompetition(planned.next.competition),
          ...roundAndPhase(planned.next),
          perShare: planned.next.perShare,
          closedAt: new Date(planned.next.closedAt),
          status: "approved",
          version,
          supersedesId: planned.current?.id ?? null,
          approvedBy: actorId,
          approvedAt: now,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: payoutEvents.id });
      // a chave ganhou uma versão vigente nesse meio tempo (a passada de fechamento gravou o evento novo)
      if (!row) throw new StaleCorrection();
      if (planned.photo.kind === "copy") await copyHoldings(tx, planned.photo.fromEventId, row.id);
      else await writeHoldings(tx, row.id, planned.photo.holdings);
      response.events.push({
        eventId: row.id,
        key: planned.key,
        ticker: planned.ticker,
        version,
        supersedesId: planned.current?.id ?? null,
        perShare: planned.next.perShare,
      });
    }

    await this.adminLog.record(tx, {
      actorId,
      action: "payout.correct",
      targetType: "payout_correction",
      targetId: plan.planCode,
      before: {
        events: plan.events.flatMap((e) =>
          e.current
            ? [{ id: e.current.id, key: e.key, version: e.current.version, perShare: e.current.perShare, closedAt: e.current.closedAt.toISOString() }]
            : [],
        ),
      },
      after: {
        // a liquidação acha aqui o motivo das versões novas (complemento e estorno em vez de dividendo)
        eventIds: response.events.map((e) => e.eventId),
        events: response.events.map((e, i) => ({ ...e, closedAt: new Date(plan.events[i]!.next.closedAt).toISOString(), outcome: plan.events[i]!.outcome })),
        wallets: plan.preview.wallets,
        months: plan.preview.months,
      },
      reason: body.reason,
    });
    // o valor dos clubes mudou: a casa repõe a cotação (com a negociação encerrada, a casa não cota mais)
    if (season.status !== "trading_ended") await this.market.requestRefresh(tx, [...new Set(plan.events.map((e) => e.ticker))], "correction");
    // o "a receber" dos meses dos fechamentos antigos e novos muda
    await this.rankings.payoutsChanged(tx, { seasonId, closedAts: plan.closedAts });
    tx.afterCommit(() => this.rankings.wake());
    tx.afterCommit(() => this.events?.adminChanged());
    return response;
  }

  /** A maior versão da chave (vigente ou não); 0 se a chave nunca teve evento. */
  private async lastVersion(tx: Tx, seasonId: number, clubId: number, key: string): Promise<number> {
    const [row] = await tx.db
      .select({ v: max(payoutEvents.version) })
      .from(payoutEvents)
      .where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.clubId, clubId), eq(payoutEvents.eventKey, key)));
    return row?.v ?? 0;
  }
}
