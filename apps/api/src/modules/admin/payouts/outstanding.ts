import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lte, ne, sql } from "drizzle-orm";
import { DB, type Database } from "../../../infra/db/index.js";
import { payoutEvents } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { CorrectionPlanService } from "./correction-plan.js";
import { type Executor, executorOf } from "./holdings.js";
import { settlingEventIds } from "./settlement.js";

/** O que falta resolver nos pagamentos da temporada (o encerramento recusa com isto: Admin, critério 21). */
export interface Outstanding {
  /** Eventos vigentes aguardando aprovação. */
  pending: number;
  /** Eventos aprovados ainda com crédito a lançar (liquidando). */
  settling: number;
  /** Eventos que a correção mudaria com os resultados de agora (0 quando não há nada a corrigir). */
  correctionEvents: number;
}

/** O pago e o a receber por ação de um clube, em centavos (para o simulador "Quanto vale para você" e o valor justo dos bots). */
export interface PerShareTotals {
  /** Soma dos valores por ação das versões vigentes aprovadas. */
  paid: number;
  /** Soma dos valores por ação das versões vigentes aguardando aprovação cujo fechamento já passou. */
  toReceive: number;
}

/** Consultas de leitura sobre os pagamentos: nada aqui grava nem trava. */
@Injectable()
export class PayoutsStatusService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly plans: CorrectionPlanService,
  ) {}

  async outstanding(seasonId: number, now: Date, executor: Executor = this.db): Promise<Outstanding> {
    const pending = await this.pendingCount(seasonId, executor);
    const settling = (await settlingEventIds(executor, seasonId)).length;
    let correctionEvents = 0;
    // enquanto liquida (ou com a temporada encerrada) o plano recusa: ainda não há correção a aplicar
    if (settling === 0 && (await this.hasApproved(seasonId, executor))) {
      try {
        correctionEvents = (await this.plans.plan(executor, seasonId, now)).events.length;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
      }
    }
    return { pending, settling, correctionEvents };
  }

  /** Sem nenhum evento aprovado não há o que corrigir (e a temporada em preparação nem tem valores para calcular). */
  private async hasApproved(seasonId: number, executor: Executor): Promise<boolean> {
    const [row] = await executorOf(executor)
      .select({ id: payoutEvents.id })
      .from(payoutEvents)
      .where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.status, "approved")))
      .limit(1);
    return row !== undefined;
  }

  async pendingCount(seasonId: number, executor: Executor = this.db): Promise<number> {
    const db = executorOf(executor);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payoutEvents)
      .where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.status, "pending")));
    return row?.n ?? 0;
  }

  async perShareTotals(seasonId: number, clubId: number, now: Date, executor: Executor = this.db): Promise<PerShareTotals> {
    const db = executorOf(executor);
    const rows = await db
      .select({ status: payoutEvents.status, total: sql<number>`coalesce(sum(${payoutEvents.perShare}), 0)::int` })
      .from(payoutEvents)
      .where(
        and(
          eq(payoutEvents.seasonId, seasonId),
          eq(payoutEvents.clubId, clubId),
          ne(payoutEvents.kind, "buyback"),
          ne(payoutEvents.kind, "relegation"),
          ne(payoutEvents.status, "superseded"),
          lte(payoutEvents.closedAt, now),
        ),
      )
      .groupBy(payoutEvents.status);
    const by = new Map(rows.map((r) => [r.status, r.total]));
    return { paid: by.get("approved") ?? 0, toReceive: by.get("pending") ?? 0 };
  }
}
