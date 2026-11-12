import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DB, type Database, lockPayoutEvents, lockSeason, lockWallets, type PayoutEventRow, type Tx, withTransaction } from "../../../infra/db/index.js";
import { payoutEvents } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../current-season.js";
import { PayoutEvents } from "./events.js";
import { SettleReversalService } from "./settle-reversal.js";
import { dues, settlingEventIds } from "./settlement.js";

/**
 * Carteiras por lote de crédito (P2). Uma transação com milhares de carteiras travadas faria toda ordem de um desses
 * donos, que trava o clube antes da carteira, segurar o livro do clube inteiro esperando. Medido na T10
 * (`scripts/payout-batch-timing.mjs`, 5.000 donos): com 200 por lote cada lote segurava as carteiras ~1,3 s (quase
 * tudo nos ~4,8 ms de cada `portfolio.post`); com 50, ~0,32 s, e a liquidação inteira só ~7% mais lenta (34 s contra 32 s).
 */
export const SETTLE_BATCH = 50;

/** Um crédito lançado num lote: o dividendo, o complemento ou o estorno (valor negativo) de uma carteira. */
export interface Credit {
  walletId: number;
  amount: number;
  entryId: number;
  kind: "dividend" | "complement" | "reversal";
}

/** O que um lote creditou, para o aviso depois do `COMMIT` (`payout.credited`, na T9). */
export interface CreditedBatch {
  eventId: number;
  seasonId: number;
  clubId: number;
  reason: string;
  credits: Credit[];
}

/** O que a liquidação de um evento fez nesta execução. */
export interface SettleEventSummary {
  eventId: number;
  /** Lotes (e transações por carteira) que fizeram `COMMIT` com algum crédito deste evento. */
  batches: number;
  credited: number;
  amount: number;
  /** Por que parou antes de acabar (o evento deixou de estar aprovado, a temporada encerrou); `null` se acabou. */
  stopped: "not_approved" | "season_closed" | null;
}

/** O que a tarefa de liquidação fez numa execução. */
export interface SettlePendingSummary {
  events: number;
  credited: number;
  errors: string[];
}

/**
 * A liquidação em lotes dos eventos aprovados (Plano dos dividendos e pagamentos, "Aprovação em lotes", etapas 2 e 3, e
 * "Aplicar a correção", etapa 2; Admin, critérios 3, 4, 12, 13 e 15; Dividendos e recompra, critério 1).
 *
 * O que cada carteira recebe ou devolve num evento sai de `dues` (`settlement.ts`): na versão comum, ações na foto ×
 * valor (o dividendo); na versão gravada por uma correção, o líquido da carteira naquela chave (complemento ou
 * estorno, com o motivo do admin). Nunca duas vezes: a linha em `payout_credits` marca a carteira como feita.
 *
 * Cada lote, até `batchSize` carteiras, é uma transação com as travas na ordem do jogo (P3): a temporada
 * (compartilhada), a linha do evento com `FOR SHARE` (conferindo que ainda é `approved`: a correção, que trava o
 * evento com `FOR UPDATE`, espera o lote acabar), as carteiras do lote em ordem de id. Com as carteiras travadas, o
 * lote reconfere o que falta (dois lotes ao mesmo tempo nunca creditam a mesma carteira; a chave de `payout_credits` é
 * a rede de segurança) e lança pelo `portfolio.post`. O dividendo e o complemento são entradas (com o caixa negativo,
 * abatem o negativo); o estorno sai no lote quando o caixa livre cobre. A carteira cujo caixa livre não cobre o estorno
 * fica para uma transação só dela, que trava antes os clubes das compras abertas e as cancela
 * (`SettleReversalService.settleWallet`).
 *
 * Retomável: o que já tem linha em `payout_credits` não é lançado de novo, então a tarefa de cada minuto
 * (`settlePending`) continua de onde um lote interrompido parou. Nenhum lote avisa os rankings: o "a receber"
 * (foto × valor menos o creditado) não muda com o crédito, só com a aprovação e a correção.
 */
@Injectable()
export class SettleCreditsService implements OnModuleDestroy {
  private readonly logger = new Logger("Pagamentos");
  /** Carteiras por lote; os testes diminuem para ver vários lotes com poucas carteiras. */
  batchSize = SETTLE_BATCH;
  /** A execução da tarefa em curso e a seguinte, já pedida (uma por vez nesta API). */
  private current: Promise<SettlePendingSummary> | null = null;
  private queued: Promise<SettlePendingSummary> | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly reversal: SettleReversalService,
    @Optional() private readonly events?: PayoutEvents,
  ) {}

  /**
   * Depois do `COMMIT` de cada lote que creditou. Ponto de extensão do aviso `payout.credited` aos donos, que a
   * T9 liga ao barramento de tempo real; por ora só registra no log. O `wallet.changed` já sai pelo `WalletEvents`
   * de cada lançamento, e o `order.updated` das compras canceladas pelo `MarketEvents` do `cancelOrders`.
   */
  onCredited(batch: CreditedBatch): void {
    this.logger.debug(`evento ${batch.eventId}: ${batch.credits.length} créditos`);
    void this.events?.credited(batch).then(() => this.events?.adminChanged());
  }

  /**
   * Liquida um evento aprovado: lotes até não sobrar carteira com algo a lançar, e depois, uma a uma, as que não cobrem
   * o estorno. Pode rodar ao mesmo tempo que outra liquidação do mesmo evento (a outra instância da API, a tarefa e a
   * rota): as travas garantem um crédito por carteira. Evento que não está aprovado não credita nada.
   */
  async settleEvent(eventId: number): Promise<SettleEventSummary> {
    const summary: SettleEventSummary = { eventId, batches: 0, credited: 0, amount: 0, stopped: null };
    const [event] = await this.db.select().from(payoutEvents).where(eq(payoutEvents.id, eventId));
    if (!event || event.status !== "approved") return { ...summary, stopped: "not_approved" };

    const deferred: number[] = [];
    let cursor: number | undefined;
    for (;;) {
      const batch = await dues(this.db, { eventId, afterWallet: cursor, limit: this.batchSize });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1]!.walletId;
      const result = await withTransaction(this.db, (tx) => this.creditBatch(tx, event, batch.map((b) => b.walletId)));
      if (result.stopped) return { ...summary, stopped: result.stopped };
      deferred.push(...result.deferred);
      if (result.credits.length > 0) {
        summary.batches++;
        summary.credited += result.credits.length;
        summary.amount += result.credits.reduce((total, c) => total + c.amount, 0);
      }
    }

    // quem não cobre o estorno: uma transação por carteira, com as compras canceladas (P5). A falha de uma carteira não
    // segura as outras (revisão T10: antes, a primeira que falhasse, sempre a mesma por ser em ordem de id, deixava as
    // seguintes sem estorno a cada execução da tarefa); o erro sobe no fim, para o log da tarefa
    const failures: Array<{ walletId: number; error: unknown }> = [];
    for (const walletId of deferred) {
      let batches: CreditedBatch[];
      try {
        batches = await this.reversal.settleWallet(event.seasonId, walletId, (b) => this.onCredited(b));
      } catch (error) {
        failures.push({ walletId, error });
        continue;
      }
      for (const b of batches.filter((x) => x.eventId === eventId)) {
        summary.batches++;
        summary.credited += b.credits.length;
        summary.amount += b.credits.reduce((total, c) => total + c.amount, 0);
      }
    }
    if (failures.length > 0) {
      const detail = failures.map((f) => `carteira ${f.walletId}: ${(f.error as Error).message}`).join("; ");
      throw new Error(`liquidação do evento ${eventId}: ${failures.length} carteira(s) sem estorno (${detail})`, { cause: failures[0]!.error });
    }
    return summary;
  }

  /** Um lote, numa transação: as travas na ordem P3, a reconferência e os créditos. */
  private async creditBatch(
    tx: Tx,
    event: PayoutEventRow,
    walletIds: number[],
  ): Promise<{ credits: Credit[]; deferred: number[]; stopped: SettleEventSummary["stopped"] }> {
    const season = await lockSeason(tx, event.seasonId, "share");
    if (season.status === "closed") return { credits: [], deferred: [], stopped: "season_closed" };
    const [locked] = await lockPayoutEvents(tx, [event.id], "share");
    // substituído por uma correção entre a leitura e a trava: a versão nova é que paga
    if (locked!.status !== "approved") return { credits: [], deferred: [], stopped: "not_approved" };
    const rows = await lockWallets(tx, walletIds);
    const cash = new Map(rows.map((w) => [w.id, w.cash - w.reservedCash]));

    // com as carteiras travadas, nenhum outro lote lança nelas: quem já recebeu fica de fora
    const due = await dues(tx, { eventId: event.id, walletIds });
    const context = (await this.reversal.contexts(tx, [locked!])).get(event.id)!;
    const credits: Credit[] = [];
    const deferred: number[] = [];
    for (const d of due) {
      // o estorno que o caixa livre não cobre cancela as compras abertas, com os clubes travados antes: fica para a
      // transação da carteira
      if (d.amount < 0 && cash.get(d.walletId)! + d.amount < 0) {
        deferred.push(d.walletId);
        continue;
      }
      credits.push(await this.reversal.postCredit(tx, context, d));
    }
    if (credits.length > 0) {
      const batch: CreditedBatch = { eventId: event.id, seasonId: event.seasonId, clubId: locked!.clubId, reason: locked!.reason, credits };
      tx.afterCommit(() => this.onCredited(batch));
    }
    return { credits, deferred, stopped: null };
  }

  /**
   * A tarefa de liquidação: todos os eventos aprovados da temporada atual com algo a lançar, em ordem de id.
   * Uma execução por vez nesta API: pedida durante outra, roda logo depois dela (os pedidos nesse meio tempo
   * viram uma execução só). A falha de um evento vai para o log e não impede os outros.
   */
  settlePending(): Promise<SettlePendingSummary> {
    if (this.queued) return this.queued;
    if (!this.current) return this.start();
    const queued = this.current
      .catch(() => undefined)
      .then(() => {
        this.queued = null;
        return this.start();
      });
    this.queued = queued;
    return queued;
  }

  /** Dispara a tarefa sem esperar (as rotas da aprovação e da correção); a falha vai para o log. */
  trigger(): void {
    this.settlePending().catch((error: unknown) => this.logger.error(`liquidação dos pagamentos falhou: ${(error as Error).message}`));
  }

  /** Espera a execução em curso e a pedida acabarem (os testes, e a API ao desligar). */
  async whenIdle(): Promise<void> {
    while (this.current || this.queued) {
      await (this.queued ?? this.current)!.catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.whenIdle();
  }

  private start(): Promise<SettlePendingSummary> {
    const run = this.runPending();
    this.current = run;
    const clear = () => {
      if (this.current === run) this.current = null;
    };
    run.then(clear, clear);
    return run;
  }

  private async runPending(): Promise<SettlePendingSummary> {
    const summary: SettlePendingSummary = { events: 0, credited: 0, errors: [] };
    const season = await currentSeason(this.db);
    if (!season) return summary;
    // os aprovados com algo a lançar (a mesma consulta que a correção usa no `payout_settling`)
    for (const eventId of await settlingEventIds(this.db, season.id)) {
      try {
        const done = await this.settleEvent(eventId);
        summary.events++;
        summary.credited += done.credited;
      } catch (error) {
        const message = `evento ${eventId}: ${(error as Error).message}`;
        this.logger.error(`liquidação falhou no ${message}`);
        summary.errors.push(message);
      }
    }
    return summary;
  }
}
