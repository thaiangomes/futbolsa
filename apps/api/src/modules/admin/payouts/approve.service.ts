import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type ApproveOutcome, type ApprovePayoutsBody, type ApprovePayoutsResponse } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { payoutEvents, seasons, standings } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason, type SeasonRow } from "../current-season.js";
import { AdminLogService } from "../log/admin-log.service.js";
import { RankingsPort } from "./ports.js";
import { STANDINGS_OF_KIND } from "./preview.service.js";

const seasonClosed = () => new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);

/**
 * A aprovação dos pagamentos (Plano dos dividendos e pagamentos, "Aprovação em lotes", etapa 1; Admin,
 * "Pagamento de dividendos", critérios 3, 4 e 33). Cada evento passa de `pending` a `approved` na sua transação
 * curta, com o registro do admin e o aviso aos rankings; o dinheiro sai depois, em lotes, pela liquidação
 * (`SettleCreditsService`). Aprovar todos é a mesma coisa, evento por evento, e a resposta diz o que houve com
 * cada um:
 * - `approved`: aprovado agora;
 * - `already_approved`: já estava aprovado (outra aprovação ganhou, ou é a segunda vez): nada é pago de novo;
 * - `event_superseded`: o resultado foi corrigido e o evento tem versão nova; a tela recarrega a prévia;
 * - `standings_not_confirmed`: colocação ou acesso com a classificação oficial ainda não conferida (o valor depende
 *   da posição final, que só vale depois da conferência do admin); o evento continua aguardando;
 * - `not_found`: não existe na temporada atual.
 */
@Injectable()
export class ApproveService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly adminLog: AdminLogService,
    private readonly rankings: RankingsPort,
  ) {}

  async approve(actorId: string, body: ApprovePayoutsBody): Promise<ApprovePayoutsResponse> {
    const season = await this.season();
    const ids = "all" in body ? await this.pendingIds(season.id) : [...new Set(body.eventIds)];
    const results: ApprovePayoutsResponse["results"] = [];
    for (const eventId of ids) {
      results.push({ eventId, outcome: await withTransaction(this.db, (tx) => this.approveOne(tx, actorId, season.id, eventId)) });
    }
    return { results };
  }

  /**
   * A temporada atual. Sem nenhuma em andamento: a mais nova encerrada recusa com `season_closed` (os pagamentos
   * dela já foram fechados no encerramento); sem temporada nenhuma, `no_season`.
   */
  private async season(): Promise<SeasonRow> {
    const current = await currentSeason(this.db);
    if (current) return current;
    const [latest] = await this.db.select().from(seasons).orderBy(desc(seasons.year)).limit(1);
    if (latest) throw seasonClosed();
    throw new DomainError("no_season", 409, ADMIN_ERROR_MESSAGES.no_season);
  }

  /** Os pendentes da temporada, em ordem de id (aprovar todos). */
  private async pendingIds(seasonId: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: payoutEvents.id })
      .from(payoutEvents)
      .where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.status, "pending")))
      .orderBy(asc(payoutEvents.id));
    return rows.map((r) => r.id);
  }

  private async approveOne(tx: Tx, actorId: string, seasonId: number, eventId: number): Promise<ApproveOutcome> {
    // a temporada compartilhada: o encerramento (exclusivo) espera, e nada é aprovado numa temporada encerrada
    const season = await lockSeason(tx, seasonId, "share");
    if (season.status === "closed") throw seasonClosed();

    const [event] = await tx.db
      .select()
      .from(payoutEvents)
      .where(and(eq(payoutEvents.id, eventId), eq(payoutEvents.seasonId, seasonId)));
    if (!event) return "not_found";
    if (event.status === "approved") return "already_approved";
    if (event.status === "superseded") return "event_superseded";

    const competition = STANDINGS_OF_KIND[event.kind as keyof typeof STANDINGS_OF_KIND];
    if (competition && !(await this.standingsConfirmed(tx, seasonId, competition))) return "standings_not_confirmed";

    const now = this.clock.now();
    // só um `pending` vira `approved`: a aprovação ao mesmo tempo (ou a passada que troca a versão) espera este
    // `UPDATE` e, ao reler a linha, não acha mais `pending`
    const [approved] = await tx.db
      .update(payoutEvents)
      .set({ status: "approved", approvedBy: actorId, approvedAt: now })
      .where(and(eq(payoutEvents.id, eventId), eq(payoutEvents.status, "pending")))
      .returning();
    if (!approved) {
      const [again] = await tx.db.select({ status: payoutEvents.status }).from(payoutEvents).where(eq(payoutEvents.id, eventId));
      return again?.status === "approved" ? "already_approved" : "event_superseded";
    }

    await this.adminLog.record(tx, {
      actorId,
      action: "payout.approve",
      targetType: "payout_event",
      targetId: String(eventId),
      before: {
        status: "pending",
        key: event.eventKey,
        version: event.version,
        perShare: event.perShare,
        closedAt: event.closedAt.toISOString(),
      },
      after: { status: "approved", perShare: approved.perShare, approvedAt: now.toISOString() },
    });
    // o "a receber" do mês do fechamento muda: o pedido de recálculo entra nesta transação
    await this.rankings.payoutsChanged(tx, { seasonId, closedAts: [approved.closedAt] });
    tx.afterCommit(() => this.rankings.wake());
    return "approved";
  }

  /** Conferida é a tabela com linhas em que todas têm a conferência (a mesma regra da prévia e da tela da classificação). */
  private async standingsConfirmed(tx: Tx, seasonId: number, competition: string): Promise<boolean> {
    const [row] = await tx.db
      .select({ total: count(), confirmed: sql<number>`count(${standings.confirmedAt})::int` })
      .from(standings)
      .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition)));
    return !!row && row.total > 0 && row.total === row.confirmed;
  }
}
