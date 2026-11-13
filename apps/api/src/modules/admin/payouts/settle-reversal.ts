import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { Clock } from "../../../infra/clock/index.js";
import {
  DB,
  type Database,
  lockClubs,
  lockPayoutEvents,
  lockSeason,
  lockWallets,
  type PayoutEventRow,
  type Tx,
  withTransaction,
} from "../../../infra/db/index.js";
import { clubs, type OrderCancelReason, payoutCredits, seasonClubs } from "../../../infra/db/schema/index.js";
import { CancelService, type CancelledOrders, ClubsNotLockedError, openOrderTickers } from "../../market/index.js";
import { PortfolioLedger, WalletEvents } from "../../portfolio/index.js";
import type { Credit, CreditedBatch } from "./settle-credits.js";
import { correctionReasonOf, type Due, dues } from "./settlement.js";

/**
 * Recomeços com a lista de clubes lida de novo antes de travar todos os clubes da temporada (Plano dos dividendos e
 * pagamentos, "Aplicar a correção", etapa 2).
 */
export const MAX_CLUB_RETRIES = 3;

/** O movimento de um crédito de pagamento: o tipo da linha do extrato e o motivo. */
export interface CreditMovement {
  kind: Credit["kind"];
  reason: string;
}

/**
 * O tipo e o motivo da linha do extrato de um crédito: na versão comum, o dividendo com o motivo do evento; na versão
 * gravada por uma correção, o complemento (entrada) ou o estorno (saída), com o motivo do admin e o do evento.
 */
export function creditMovement(amount: number, eventReason: string, correctionReason: string | null): CreditMovement {
  if (correctionReason === null) return { kind: amount > 0 ? "dividend" : "reversal", reason: eventReason };
  return { kind: amount > 0 ? "complement" : "reversal", reason: `Correção: ${correctionReason} (${eventReason})` };
}

/** O contexto de um evento na liquidação: a linha travada, o ticker e o motivo da correção (se é uma). */
export interface SettleEventContext {
  row: PayoutEventRow;
  ticker: string;
  correctionReason: string | null;
}

/** Só para os testes de concorrência. */
export interface SettleReversalHooks {
  /** Depois de ler sem trava os clubes com compras abertas da carteira, antes de travar qualquer coisa. */
  afterClubsRead?: (walletId: number, attempt: number) => Promise<void>;
}

/**
 * O estorno de quem não cobre (Plano dos dividendos e pagamentos, "Aplicar a correção", etapa 2; Admin, critérios 12
 * e 15; P5): a carteira cujo caixa livre (caixa − reservado) mais o que ela recebe e devolve fica abaixo de zero tem
 * **todas** as compras abertas canceladas, em todos os clubes, e o caixa pode ficar negativo, sem nada reservado. As
 * vendas abertas ficam.
 *
 * Uma transação só para a carteira, com as travas na ordem do jogo (P3): a temporada (compartilhada); os clubes onde
 * ela tem compras abertas, lidos antes sem trava, em ordem de ticker; as linhas dos eventos com o que falta lançar
 * nela, `FOR SHARE`, em ordem de id; a carteira. Com tudo travado, relê o que falta, cancela as compras pelo
 * `cancelOrders` da F9 (que devolve a reserva e recusa, com `ClubsNotLockedError`, compra num clube não travado: uma
 * compra nova entrou entre a leitura e a trava) e lança os complementos e depois os estornos. No `ClubsNotLockedError`
 * a transação termina sem gravar nada e recomeça com a lista nova, até `MAX_CLUB_RETRIES` vezes; depois trava todos os
 * clubes da temporada.
 */
@Injectable()
export class SettleReversalService {
  hooks: SettleReversalHooks = {};

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: PortfolioLedger,
    private readonly walletEvents: WalletEvents,
    private readonly cancels: CancelService,
    private readonly clock: Clock,
  ) {}

  /**
   * Cancela todas as compras abertas da carteira quando o caixa livre não cobre `toReturn` (em centavos, o que ela vai
   * devolver), pelo `cancelOrders` da F9 com o motivo dado, que devolve a reserva. Cobrindo, não cancela nada. As vendas
   * ficam. Quem chama já travou, na ordem do jogo, os clubes dessas compras (`openOrderTickers` com `side: "buy"`) e a
   * carteira; uma compra num clube não travado dá `ClubsNotLockedError` antes de qualquer gravação. A F12 usa com
   * `reversal`; a F14, na anulação por trapaça, com `annulment` (que entra em `orders.cancel_reason` pela migração dela).
   */
  async cancelBuysToCover(tx: Tx, walletId: number, toReturn: number, reason: OrderCancelReason): Promise<CancelledOrders> {
    const [wallet] = await lockWallets(tx, [walletId]);
    if (wallet!.cash - wallet!.reservedCash >= toReturn) return { orders: [], posts: [] };
    return this.cancels.cancelOrders(tx, walletId, { side: "buy" }, reason, this.clock.now());
  }

  /**
   * Liquida numa transação própria tudo o que falta lançar numa carteira, em todos os eventos aprovados da temporada:
   * cancela as compras se o caixa livre não cobre, complementos antes, estornos depois. Devolve o que creditou por
   * evento; `onCredited` roda depois do `COMMIT`.
   */
  async settleWallet(seasonId: number, walletId: number, onCredited: (batch: CreditedBatch) => void): Promise<CreditedBatch[]> {
    for (let attempt = 0; ; attempt++) {
      const allClubs = attempt >= MAX_CLUB_RETRIES;
      const outcome = await withTransaction(this.db, (tx) => this.walletTx(tx, seasonId, walletId, attempt, allClubs, onCredited));
      if (outcome !== "retry") return outcome;
      if (allClubs) throw new Error(`carteira ${walletId}: compra aberta em clube não travado mesmo com todos os clubes da temporada travados`);
    }
  }

  private async walletTx(
    tx: Tx,
    seasonId: number,
    walletId: number,
    attempt: number,
    allClubs: boolean,
    onCredited: (batch: CreditedBatch) => void,
  ): Promise<CreditedBatch[] | "retry"> {
    // sem trava: os clubes onde a carteira tem compras abertas (ou todos, depois dos recomeços)
    const tickers = allClubs ? await this.seasonTickers(tx, seasonId) : await openOrderTickers(tx, walletId, { side: "buy" });
    await this.hooks.afterClubsRead?.(walletId, attempt);

    const season = await lockSeason(tx, seasonId, "share");
    if (season.status === "closed") return [];
    await lockClubs(tx, seasonId, tickers);
    const owed = await dues(tx, { seasonId, walletIds: [walletId] });
    if (owed.length === 0) return [];
    const locked = (await lockPayoutEvents(tx, [...new Set(owed.map((d) => d.eventId))], "share")).filter((e) => e.status === "approved");
    await lockWallets(tx, [walletId]);

    // relê com tudo travado: um lote de outra instância pode ter lançado nesse meio tempo
    const due = await dues(tx, { eventIds: locked.map((e) => e.id), walletIds: [walletId] });
    if (due.length === 0) return [];
    const contexts = await this.contexts(tx, locked);
    const total = due.reduce((sum, d) => sum + d.amount, 0);
    try {
      if (total < 0) await this.cancelBuysToCover(tx, walletId, -total, "reversal");
    } catch (error) {
      // nada foi gravado: a transação termina e recomeça lendo os clubes de novo
      if (error instanceof ClubsNotLockedError) return "retry";
      throw error;
    }

    // complementos antes dos estornos: o caixa só fica negativo depois de tudo o que entra
    const ordered = [...due.filter((d) => d.amount > 0), ...due.filter((d) => d.amount < 0)];
    const batches = new Map<number, CreditedBatch>();
    for (const d of ordered) {
      const context = contexts.get(d.eventId)!;
      const credit = await this.postCredit(tx, context, d);
      let batch = batches.get(d.eventId);
      if (!batch) {
        const { row } = context;
        batches.set(d.eventId, (batch = { eventId: row.id, seasonId: row.seasonId, clubId: row.clubId, reason: row.reason, credits: [] }));
      }
      batch.credits.push(credit);
    }
    const out = [...batches.values()];
    for (const batch of out) tx.afterCommit(() => onCredited(batch));
    return out;
  }

  /**
   * Lança um crédito (dividendo, complemento ou estorno) com a carteira travada e grava a linha em `payout_credits`,
   * com o aviso `wallet.changed` ao dono depois do `COMMIT`.
   *
   * Recompra (F15, T4; Dividendos e recompra, critérios 21 e 24; Carteira e gráficos, critério 21): na versão sem
   * correção, a carteira da foto vende as ações dela à casa pelo valor da recompra, numa linha `buyback` só (o caixa
   * ações × valor, as ações saindo com o resultado realizado, inclusive a R$ 0,00). Na versão gravada por uma correção
   * as ações já saíram: o complemento ou o estorno é só em dinheiro, como nos dividendos.
   */
  async postCredit(tx: Tx, context: SettleEventContext, due: Pick<Due, "walletId" | "amount" | "shares">): Promise<Credit> {
    const { row, ticker, correctionReason } = context;
    const sale = row.kind === "buyback" && correctionReason === null && due.shares > 0;
    const movement: CreditMovement = sale ? { kind: "buyback", reason: row.reason } : creditMovement(due.amount, row.reason, correctionReason);
    const result = await this.ledger.post(tx, {
      walletId: due.walletId,
      at: this.clock.now(),
      kind: movement.kind,
      clubId: row.clubId,
      cashDelta: due.amount,
      ...(sale ? { sharesDelta: -due.shares, price: row.perShare, costBasis: "sale" as const } : {}),
      ref: { type: "payout_event", id: row.id },
      reason: movement.reason,
    });
    await tx.db.insert(payoutCredits).values({ eventId: row.id, walletId: due.walletId, amount: due.amount, entryId: result.entry.id });
    await this.walletEvents.posted(tx, result, ticker);
    return { walletId: due.walletId, amount: due.amount, entryId: result.entry.id, kind: movement.kind };
  }

  /** O ticker e o motivo da correção de cada evento. */
  async contexts(tx: Tx, rows: readonly PayoutEventRow[]): Promise<Map<number, SettleEventContext>> {
    const out = new Map<number, SettleEventContext>();
    if (rows.length === 0) return out;
    const tickers = await tx.db
      .select({ id: clubs.id, ticker: clubs.ticker })
      .from(clubs)
      .where(inArray(clubs.id, [...new Set(rows.map((r) => r.clubId))]));
    const tickerOf = new Map(tickers.map((c) => [c.id, c.ticker ?? `EXT-${c.id}`]));
    for (const row of rows) {
      out.set(row.id, { row, ticker: tickerOf.get(row.clubId)!, correctionReason: await correctionReasonOf(tx, row.id) });
    }
    return out;
  }

  /** Os tickers de todos os clubes listados na temporada. */
  private async seasonTickers(tx: Tx, seasonId: number): Promise<string[]> {
    const rows = await tx.db
      .select({ ticker: clubs.ticker })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, seasonId)));
    return rows.flatMap((r) => (r.ticker ? [r.ticker] : []));
  }
}
