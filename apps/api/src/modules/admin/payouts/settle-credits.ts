import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { Clock } from "../../../infra/clock/index.js";
import {
  DB,
  type Database,
  lockPayoutEvents,
  lockSeason,
  lockWallets,
  type PayoutEventRow,
  type Tx,
  withTransaction,
} from "../../../infra/db/index.js";
import { payoutCredits, payoutEvents } from "../../../infra/db/schema/index.js";
import { PortfolioLedger } from "../../portfolio/index.js";
import { currentSeason } from "../current-season.js";
import { type Executor, executorOf } from "./holdings.js";
import { settlingEventIds } from "./settlement.js";

/**
 * Carteiras por lote de crédito (P2; proposta, a T8 mede). Uma transação com milhares de carteiras travadas faria
 * toda ordem de um desses donos, que trava o clube antes da carteira, segurar o livro do clube inteiro esperando;
 * com 200 por lote, a espera fica em milissegundos e o resultado é o mesmo.
 */
export const SETTLE_BATCH = 200;

/** Um crédito lançado num lote. */
export interface Credit {
  walletId: number;
  amount: number;
  entryId: number;
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
  /** Lotes que fizeram `COMMIT` com algum crédito. */
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
 * Quem recebe pela foto (P6): bots e jogadores, inclusive os bloqueados; a conta excluída não recebe, e a
 * tesouraria nunca (ela não está na foto, mas fica de fora aqui também). A mesma regra da prévia.
 */
const RECEIVES = sql.raw(`(w.owner_type = 'bot' or (w.owner_type = 'user' and u.status <> 'deleted'))`);

/** As carteiras da foto do evento que recebem e ainda não têm a linha do crédito, em ordem de carteira. */
function missingQuery(eventId: number, walletIds: readonly number[] | null, limit: number | null) {
  return sql`
    select h.wallet_id, h.shares
    from futbolsa.payout_holdings h
    join futbolsa.wallets w on w.id = h.wallet_id
    left join futbolsa.users u on u.id = w.user_id
    where h.event_id = ${eventId} and ${RECEIVES}
      ${walletIds ? sql`and h.wallet_id in (${sql.join(walletIds.map((id) => sql`${id}`), sql`, `)})` : sql``}
      and not exists (select 1 from futbolsa.payout_credits c where c.event_id = h.event_id and c.wallet_id = h.wallet_id)
    order by h.wallet_id
    ${limit === null ? sql`` : sql`limit ${limit}`}`;
}

async function missing(
  executor: Executor,
  eventId: number,
  options: { walletIds?: readonly number[]; limit?: number },
): Promise<Array<{ walletId: number; shares: number }>> {
  const result = await executorOf(executor).execute(missingQuery(eventId, options.walletIds ?? null, options.limit ?? null));
  return result.rows.map((r) => ({ walletId: Number(r.wallet_id), shares: Number(r.shares) }));
}

/**
 * A liquidação em lotes dos eventos aprovados (Plano dos dividendos e pagamentos, "Aprovação em lotes", etapas 2 e
 * 3; Admin, critérios 3 e 4; Dividendos e recompra, critério 1): o dividendo cai no caixa de quem estava na foto
 * do fechamento, pelas ações dela, e nunca duas vezes.
 *
 * Cada lote, até `batchSize` carteiras, é uma transação com as travas na ordem do jogo (P3): a temporada
 * (compartilhada), a linha do evento com `FOR SHARE` (conferindo que ainda é `approved`: a correção, que trava o
 * evento com `FOR UPDATE`, espera o lote acabar), as carteiras do lote em ordem de id. Com as carteiras travadas, o
 * lote reconfere quais ainda não têm crédito (dois lotes ao mesmo tempo nunca creditam a mesma carteira; a chave
 * de `payout_credits` é a rede de segurança) e lança `dividend` pelo `portfolio.post` com a linha em
 * `payout_credits`. O dividendo é uma entrada: com o caixa negativo, ele abate o negativo.
 *
 * Retomável: o que já tem linha em `payout_credits` não é pago de novo, então a tarefa de cada minuto
 * (`settlePending`) continua de onde um lote interrompido parou. Nenhum lote avisa os rankings: o "a receber"
 * (foto × valor menos o creditado) não muda com o crédito, só com a aprovação.
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
    private readonly ledger: PortfolioLedger,
    private readonly clock: Clock,
  ) {}

  /**
   * Depois do `COMMIT` de cada lote que creditou. Ponto de extensão do aviso `payout.credited` aos donos, que a
   * T9 liga ao barramento de tempo real; por ora só registra no log.
   */
  onCredited(batch: CreditedBatch): void {
    this.logger.debug(`evento ${batch.eventId}: ${batch.credits.length} créditos de dividendo`);
  }

  /**
   * Liquida um evento aprovado: lotes até não sobrar carteira que recebe sem crédito. Pode rodar ao mesmo tempo
   * que outra liquidação do mesmo evento (a outra instância da API, a tarefa e a rota): as travas garantem um
   * crédito por carteira. Evento que não está aprovado, ou de valor R$ 0,00, não credita nada.
   */
  async settleEvent(eventId: number): Promise<SettleEventSummary> {
    const summary: SettleEventSummary = { eventId, batches: 0, credited: 0, amount: 0, stopped: null };
    const [event] = await this.db.select().from(payoutEvents).where(eq(payoutEvents.id, eventId));
    if (!event || event.status !== "approved") return { ...summary, stopped: "not_approved" };
    if (event.perShare === 0) return summary;

    let previousFirst: number | null = null;
    for (;;) {
      const batch = await missing(this.db, eventId, { limit: this.batchSize });
      if (batch.length === 0) return summary;
      const result = await withTransaction(this.db, (tx) => this.creditBatch(tx, event, batch.map((b) => b.walletId)));
      if (result.stopped) return { ...summary, stopped: result.stopped };
      if (result.credits.length > 0) {
        summary.batches++;
        summary.credited += result.credits.length;
        summary.amount += result.credits.reduce((total, c) => total + c.amount, 0);
      } else if (previousFirst === batch[0]!.walletId) {
        // o mesmo lote duas vezes sem crédito: algo fora da regra (não deveria acontecer); para em vez de girar
        throw new Error(`liquidação do evento ${eventId} sem progresso na carteira ${previousFirst}`);
      }
      previousFirst = batch[0]!.walletId;
    }
  }

  /** Um lote, numa transação: as travas na ordem P3, a reconferência e os créditos. */
  private async creditBatch(
    tx: Tx,
    event: PayoutEventRow,
    walletIds: number[],
  ): Promise<{ credits: Credit[]; stopped: SettleEventSummary["stopped"] }> {
    const season = await lockSeason(tx, event.seasonId, "share");
    if (season.status === "closed") return { credits: [], stopped: "season_closed" };
    const [locked] = await lockPayoutEvents(tx, [event.id], "share");
    // substituído por uma correção entre a leitura e a trava: a versão nova é que paga
    if (locked!.status !== "approved") return { credits: [], stopped: "not_approved" };
    await lockWallets(tx, walletIds);

    // com as carteiras travadas, nenhum outro lote credita nelas: quem já recebeu fica de fora
    const due = await missing(tx, event.id, { walletIds });
    const at = this.clock.now();
    const credits: Credit[] = [];
    for (const { walletId, shares } of due) {
      const amount = shares * locked!.perShare;
      const { entry } = await this.ledger.post(tx, {
        walletId,
        at,
        kind: "dividend",
        clubId: locked!.clubId,
        cashDelta: amount,
        ref: { type: "payout_event", id: locked!.id },
        reason: locked!.reason,
      });
      credits.push({ walletId, amount, entryId: entry.id });
    }
    if (credits.length > 0) {
      await tx.db.insert(payoutCredits).values(credits.map((c) => ({ eventId: event.id, ...c })));
      const batch: CreditedBatch = { eventId: event.id, seasonId: event.seasonId, clubId: locked!.clubId, reason: locked!.reason, credits };
      tx.afterCommit(() => this.onCredited(batch));
    }
    return { credits, stopped: null };
  }

  /**
   * A tarefa de liquidação: todos os eventos aprovados da temporada atual com crédito faltando, em ordem de id.
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

  /** Dispara a tarefa sem esperar (a rota da aprovação); a falha vai para o log. */
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
    // os aprovados com menos créditos do que carteiras que recebem (a mesma consulta que a correção usa no `payout_settling`)
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
