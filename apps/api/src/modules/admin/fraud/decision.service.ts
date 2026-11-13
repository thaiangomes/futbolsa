import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  clubChannel,
  confirmFraudResponseSchema,
  FRAUD_ERROR_MESSAGES,
  historyChangedEventSchema,
  type ConfirmFraudBody,
  type ConfirmFraudResponse,
  type DismissFraudBody,
  type DismissFraudResponse,
  type FraudBanOffer,
  type NoticeTrade,
} from "@futbolsa/contracts";
import {
  buy,
  debitShares,
  holdingKey,
  planAnnulment,
  planCashAnnulment,
  replayCost,
  type AnnulStep,
  type AnnulTrade,
  type Cents,
  type ReplayEntry,
} from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockSeason, lockWallets, type Tx, withTransaction } from "../../../infra/db/index.js";
import {
  clubs,
  fraudCases,
  fraudCaseTrades,
  fraudWarnings,
  payoutEvents,
  payoutHoldings,
  positions,
  tradeAnnulments,
  trades,
  users,
  walletEntries,
  wallets,
} from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { NoticeMailJob } from "../../../infra/jobs/notice-mail.js";
import { EventBus } from "../../../infra/realtime/index.js";
import { NoticesService } from "../../accounts/notices.service.js";
import {
  BookPublisher,
  CancelService,
  claimIdempotencyKey,
  isInAuction,
  openOrderTickers,
  requestHash,
  saveIdempotentResponse,
  TRADE_REF,
  TradeAnnulService,
  tradeNotAnnullable,
} from "../../market/index.js";
import { PortfolioLedger, WalletEvents } from "../../portfolio/index.js";
import type { PostResult } from "../../portfolio/ledger/post.js";
import { RecalcService } from "../../rankings/recalc.service.js";
import { AdminLogService } from "../log/index.js";
import { SettleReversalService } from "../payouts/settle-reversal.js";
import { reportHash } from "./report.js";
import { FraudReportService, type CaseRow } from "./report.service.js";

const ROUTE = "POST /admin/fraud/cases/:id/confirm";
/** O motivo do pedido de recálculo dos rankings (P12 do Plano dos rankings). */
const RECALC_REASON = "trapaça: negócios anulados";

const fail = (code: "case_not_found" | "case_already_decided" | "annul_not_allowed" | "club_in_auction") =>
  new DomainError(code, code === "case_not_found" ? 404 : 409, FRAUD_ERROR_MESSAGES[code]);
const self = () => new DomainError("cannot_target_self", 409, ADMIN_ERROR_MESSAGES.cannot_target_self);

/** Uma das duas contas do caso, lida do banco: jogador, bot ou conta excluída. */
interface Party {
  walletId: number;
  kind: "player" | "bot" | "deleted";
  userId: string | null;
  nickname: string | null;
}

/** Um negócio marcado pelo admin, como a decisão o lê. */
interface PickedTrade {
  id: number;
  at: Date;
  clubId: number;
  ticker: string;
  quantity: number;
  price: number;
  buyerWalletId: number;
  sellerWalletId: number;
}

/** O que cada negócio deu: o que volta, o que falta e o dinheiro (do comprador, líquido no modo em dinheiro). */
interface Outcome {
  tradeId: number;
  clubId: number;
  ticker: string;
  price: number;
  buyerWallet: number;
  sellerWallet: number;
  returned: number;
  short: number;
  /** O que o comprador recebe (o vendedor devolve); no modo em dinheiro, `ações × (preço − recompra)`. */
  buyerCash: Cents;
}

/** Só para os testes de concorrência. */
export interface FraudDecisionHooks {
  /** Depois da leitura sem trava (passo 1), antes de travar qualquer coisa. */
  afterRead?: (caseId: number) => Promise<void>;
}

/**
 * Decidir um caso de trapaça (Admin, critérios 42 e 44; T25 do Plano do admin de jogadores e bots, "Decidir").
 *
 * **Descartar** só muda o caso, guarda a foto do relatório e registra: nada é anulado e ninguém é avisado.
 *
 * **Confirmar** desfaz os negócios marcados numa transação só (`withTransaction`, que repete em *deadlock*):
 * 1. lê sem trava os negócios, os clubes deles e aqueles onde as contas vivas têm compras abertas (como a T7 da F12);
 * 2. trava as linhas de usuário das duas contas (proposta 5), a temporada (compartilhada), os clubes em ordem de
 *    ticker, o caso (pelo `UPDATE` do passo 3) e as carteiras em ordem de id; a tesouraria por último, só quando uma das
 *    contas foi excluída e a negociação está aberta (proposta 21: ela fica no lugar da conta excluída);
 * 3. marca o caso com `UPDATE … WHERE status = 'open'`; sem linha de volta, `case_already_decided`. A foto do relatório
 *    é tirada aqui, antes de mexer em qualquer coisa, com os marcados como o "sem";
 * 4. cancela as vendas do comprador que não tem as ações livres naquele clube, motivo `annulment`, e planeja pelo
 *    `planAnnulment` do motor (do mais novo para o mais antigo, com a falta, proposta 17);
 * 5. cancela as compras de quem vai pagar mais que o caixa livre (`cancelBuysToCover` da F12); o caixa pode ficar negativo;
 * 6. uma linha `trade_annulled` por negócio em cada carteira viva, com o custo e o resultado de `replayCost`
 *    (proposta 18); a linha é gravada mesmo com a falta total, para o extrato dizer o que aconteceu;
 * 7. `market.annulTrades`: o negócio sai do preço, dos candles e da referência do túnel, e a casa é reposta;
 * 8. pede o recálculo dos rankings desde o negócio anulado mais antigo;
 * 9. grava a foto e o hash, as advertências (uma por conta de jogador; bot não tem), os avisos e o registro do admin;
 * 10. depois do `COMMIT`: `wallet.changed` e `entry.added` (e `order.updated` pelo cancelamento), o livro e o preço
 *    republicados (`markClubDirty`), `history_changed` no canal do clube e o envio dos e-mails e o recálculo acordados.
 *
 * Em `trading_ended` (proposta 20) as ações não se movem: cada negócio é desfeito em dinheiro, pelo preço dele e pela
 * recompra por ação do evento de recompra vigente do clube (`planCashAnnulment`), sobre as ações da foto da recompra.
 * Com conta excluída, só a conta viva faz a parte dela e a tesouraria não entra.
 *
 * A resposta traz `banOffer`: as contas de jogador que já tinham advertência nesta temporada antes deste caso. Nada
 * acontece sozinho; o banimento é a T27.
 */
@Injectable()
export class FraudDecisionService {
  hooks: FraudDecisionHooks = {};

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
    private readonly reports: FraudReportService,
    private readonly ledger: PortfolioLedger,
    private readonly walletEvents: WalletEvents,
    private readonly cancels: CancelService,
    private readonly reversal: SettleReversalService,
    private readonly annuls: TradeAnnulService,
    private readonly book: BookPublisher,
    private readonly recalc: RecalcService,
    private readonly notices: NoticesService,
    private readonly mail: NoticeMailJob,
    private readonly bus: EventBus,
  ) {
    bus.registerSchema("history_changed", historyChangedEventSchema);
  }

  /** `POST /admin/fraud/cases/:id/dismiss`: descartar não anula nada e não avisa ninguém. */
  async dismiss(adminId: string, caseId: number, body: DismissFraudBody): Promise<DismissFraudResponse> {
    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      const c0 = await this.caseOf(tx, caseId);
      const parties = await this.parties(tx, c0);
      if (parties.some((p) => p.userId === adminId)) throw self();
      const c = await this.decide(tx, caseId, "dismissed", adminId, body.reason, now);
      const report = await this.reports.compute(tx, c);
      const hash = reportHash(report);
      await tx.db.update(fraudCases).set({ report, reportHash: hash }).where(eq(fraudCases.id, caseId));
      await this.log.record(tx, {
        actorId: adminId,
        action: "fraud.dismiss",
        targetType: "fraud_case",
        targetId: String(caseId),
        reason: body.reason,
        before: { status: "open" },
        after: { status: "dismissed", reportHash: hash },
      });
      return { caseId, status: "dismissed" };
    });
  }

  /** `POST /admin/fraud/cases/:id/confirm` com `Idempotency-Key`: a mesma chave não anula duas vezes. */
  async confirm(adminId: string, caseId: number, body: ConfirmFraudBody, key: string): Promise<ConfirmFraudResponse> {
    const now = this.clock.now();
    const ref = { userId: adminId, key, requestHash: requestHash(`${ROUTE}|${caseId}`, { ...body }) };
    return withTransaction(this.db, async (tx) => {
      const claim = await claimIdempotencyKey(tx, ref, now);
      if (claim.kind === "replay") return confirmFraudResponseSchema.parse(claim.response.body);
      if (claim.kind === "conflict") throw new DomainError("idempotency_conflict", 409, ADMIN_ERROR_MESSAGES.idempotency_conflict);
      const response = await this.confirmTx(tx, adminId, caseId, body, now);
      await saveIdempotentResponse(tx, ref, { status: 200, body: response });
      return response;
    });
  }

  private async confirmTx(tx: Tx, adminId: string, caseId: number, body: ConfirmFraudBody, now: Date): Promise<ConfirmFraudResponse> {
    // 1. sem trava: o caso, as contas, os negócios e os clubes a travar
    const c0 = await this.caseOf(tx, caseId);
    const parties0 = await this.parties(tx, c0);
    if (parties0.some((p) => p.userId === adminId)) throw self();
    const picked0 = await this.pickedTrades(tx, c0, body.tradeIds);
    const tradeTickers = [...new Set(picked0.map((t) => t.ticker))].sort();
    const tickers = new Set(tradeTickers);
    for (const p of parties0) {
      if (p.kind === "deleted") continue;
      for (const t of await openOrderTickers(tx, p.walletId, { side: "buy" })) tickers.add(t);
    }
    await this.hooks.afterRead?.(caseId);

    // 2. as travas, na ordem do jogo
    const userIds = parties0.flatMap((p) => (p.userId ? [p.userId] : []));
    const deletedIds = await this.deletedUsersOf(tx, c0);
    const lockedUsers = [...new Set([...userIds, ...deletedIds])].sort();
    if (lockedUsers.length > 0) {
      await tx.db.select({ id: users.id }).from(users).where(inArray(users.id, lockedUsers)).orderBy(asc(users.id)).for("share");
    }
    const season = await lockSeason(tx, c0.seasonId, "share");
    if (season.status !== "trading" && season.status !== "trading_ended") throw fail("annul_not_allowed");
    const cashMode = season.status === "trading_ended";
    const lockedClubs = await lockClubs(tx, season.id, [...tickers]);
    if (lockedClubs.some((club) => tradeTickers.includes(club.ticker) && isInAuction(club))) throw fail("club_in_auction");

    // 3. o caso: só uma decisão passa
    const c = await this.decide(tx, caseId, "confirmed", adminId, body.reason, now);
    // relidos com tudo travado: a exclusão de uma conta ou outra anulação podem ter terminado antes da trava
    const parties = await this.parties(tx, c);
    const picked = await this.pickedTrades(tx, c, body.tradeIds);
    const report = await this.reports.compute(tx, c, body.tradeIds, new Set(body.tradeIds));
    const hash = reportHash(report);

    const deleted = parties.some((p) => p.kind === "deleted");
    const live = parties.filter((p) => p.kind !== "deleted").map((p) => p.walletId);
    const treasury = !cashMode && deleted ? await this.treasuryOf(tx, c.seasonId) : null;
    await lockWallets(tx, treasury === null ? live : [...live, treasury]);
    const kindOf = new Map(parties.map((p) => [p.walletId, p.kind]));
    /** Quem faz a parte de cada conta: ela mesma ou, se foi excluída e as ações se movem, a tesouraria. */
    const standIn = (walletId: number) => (kindOf.get(walletId) === "deleted" && treasury !== null ? treasury : walletId);
    const isLive = (walletId: number) => kindOf.get(walletId) !== undefined && kindOf.get(walletId) !== "deleted";

    // 4 e 5. o plano, com as vendas e as compras canceladas antes quando faltam ações ou caixa
    const outcomes = cashMode
      ? await this.planCash(tx, c.seasonId, picked)
      : await this.planShares(tx, picked, standIn, isLive, now);
    await this.coverCash(tx, outcomes, isLive);

    // 6. as linhas trade_annulled
    const posted: Array<{ result: PostResult; ticker: string }> = [];
    const current = new Map<number, number>();
    for (const o of outcomes) {
      current.set(o.tradeId, o.short);
      for (const side of ["buyer", "seller"] as const) {
        const walletId = side === "buyer" ? o.buyerWallet : o.sellerWallet;
        const live = isLive(walletId);
        if (!live && (walletId !== treasury || o.returned === 0)) continue;
        const sharesDelta = cashMode ? 0 : side === "buyer" ? -o.returned : o.returned;
        const cashDelta = !live ? 0 : side === "buyer" ? o.buyerCash : -o.buyerCash;
        const annulled = cashMode
          ? await this.cashCost(tx, walletId, o.clubId, cashDelta)
          : await this.annulledCost(tx, walletId, o, sharesDelta, current, live);
        const result = await this.ledger.post(tx, {
          walletId,
          at: now,
          kind: "trade_annulled",
          clubId: o.clubId,
          sharesDelta,
          cashDelta,
          price: o.price,
          annulled,
          ref: { type: TRADE_REF, id: o.tradeId },
          reason: body.reason,
        });
        posted.push({ result, ticker: o.ticker });
      }
    }

    // 7. o negócio sai do preço, dos candles e da referência do túnel
    const annul = await this.annuls.annulTrades(tx, {
      seasonId: c.seasonId,
      caseId,
      at: now,
      trades: outcomes.map((o) => ({ tradeId: o.tradeId, sharesReturned: o.returned, cashReturned: o.buyerCash, sharesShort: o.short })),
    });

    // 8. o recálculo dos rankings desde o negócio anulado mais antigo
    await this.recalc.requestRecalc(tx, { seasonId: c.seasonId, from: annul.since, reason: RECALC_REASON });

    // 9. a foto, as advertências, os avisos e o registro
    await tx.db.update(fraudCases).set({ report, reportHash: hash }).where(eq(fraudCases.id, caseId));
    await tx.db
      .update(fraudCaseTrades)
      .set({ selected: true })
      .where(and(eq(fraudCaseTrades.caseId, caseId), inArray(fraudCaseTrades.tradeId, body.tradeIds)));
    const banOffer: FraudBanOffer[] = [];
    const noticeTrades: NoticeTrade[] = picked.map((t) => ({ at: t.at.toISOString(), ticker: t.ticker, quantity: t.quantity, price: t.price, value: t.quantity * t.price }));
    for (const p of parties) {
      if (p.kind !== "player" || !p.userId) continue;
      const [previous] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(fraudWarnings)
        .where(and(eq(fraudWarnings.userId, p.userId), eq(fraudWarnings.seasonId, c.seasonId)));
      await tx.db.insert(fraudWarnings).values({ userId: p.userId, seasonId: c.seasonId, caseId, at: now });
      if (previous!.n > 0) banOffer.push({ userId: p.userId, label: p.nickname ?? "", previousWarnings: previous!.n });
      await this.notices.create(tx, { userId: p.userId, kind: "fraud_warning", body: { reason: body.reason, trades: noticeTrades }, at: now });
    }
    const annulled = outcomes.map((o) => ({ tradeId: o.tradeId, sharesReturned: o.returned, sharesShort: o.short, cashReturned: o.buyerCash }));
    await this.log.record(tx, {
      actorId: adminId,
      action: "fraud.confirm",
      targetType: "fraud_case",
      targetId: String(caseId),
      reason: body.reason,
      before: { status: "open" },
      after: { status: "confirmed", reportHash: hash, mode: cashMode ? "cash" : "shares", annulled },
    });

    // 10. depois do COMMIT
    for (const p of posted) await this.walletEvents.posted(tx, p.result, p.ticker);
    for (const club of annul.clubs) {
      this.book.markClubDirty(tx, club.ticker);
      tx.afterCommit(() => this.bus.publish(clubChannel(club.ticker), "history_changed", {}));
    }
    tx.afterCommit(() => {
      this.mail.wake();
      this.recalc.wake();
    });
    return { caseId, status: "confirmed", annulled, banOffer };
  }

  /**
   * O plano com as ações se movendo (negociação aberta). Planeja sobre as ações livres; o comprador vivo a quem faltam
   * ações e que as tem presas em vendas naquele clube tem essas vendas canceladas (motivo `annulment`), e o plano é
   * refeito com as ações liberadas. A tesouraria (no lugar da conta excluída) não tem ordem cancelada: sem ações livres
   * bastantes, vale a falta.
   */
  private async planShares(
    tx: Tx,
    picked: readonly PickedTrade[],
    standIn: (walletId: number) => number,
    isLive: (walletId: number) => boolean,
    now: Date,
  ): Promise<Outcome[]> {
    const input: AnnulTrade[] = picked.map((t) => ({
      id: t.id,
      at: t.at.getTime(),
      clubId: t.clubId,
      buyerWallet: standIn(t.buyerWalletId),
      sellerWallet: standIn(t.sellerWalletId),
      quantity: t.quantity,
      price: t.price,
    }));
    const tickerOf = new Map(picked.map((t) => [t.clubId, t.ticker]));
    const plan = async () => {
      // as duas contas no lugar da tesouraria: ninguém move nada, e o negócio sai só do preço
      const moving = input.filter((t) => t.buyerWallet !== t.sellerWallet);
      const steps = planAnnulment(moving, await this.freeShares(tx, moving)).steps;
      const still = input.filter((t) => t.buyerWallet === t.sellerWallet).map((t): AnnulStep => ({ tradeId: t.id, clubId: t.clubId, buyerWallet: t.buyerWallet, sellerWallet: t.sellerWallet, price: t.price, quantity: t.quantity, returned: 0, short: t.quantity, cash: 0 }));
      return [...steps, ...still];
    };
    let steps = await plan();
    const toCancel = new Map<string, { walletId: number; ticker: string }>();
    for (const s of steps) {
      if (s.short === 0 || !isLive(s.buyerWallet)) continue;
      toCancel.set(holdingKey(s.buyerWallet, s.clubId), { walletId: s.buyerWallet, ticker: tickerOf.get(s.clubId)! });
    }
    let cancelled = 0;
    for (const { walletId, ticker } of toCancel.values()) {
      const done = await this.cancels.cancelOrders(tx, walletId, { side: "sell", tickers: [ticker] }, "annulment", now);
      cancelled += done.orders.length;
    }
    if (cancelled > 0) steps = await plan();
    return steps.map((s) => ({
      tradeId: s.tradeId,
      clubId: s.clubId,
      ticker: tickerOf.get(s.clubId)!,
      price: s.price,
      buyerWallet: s.buyerWallet,
      sellerWallet: s.sellerWallet,
      returned: s.returned,
      short: s.short,
      buyerCash: s.cash,
    }));
  }

  /**
   * O plano em dinheiro (negociação encerrada): a recompra por ação do evento vigente de cada clube e as ações da foto
   * dele. Clube sem evento de recompra ainda não tem a conta da recompra: `annul_not_allowed`.
   */
  private async planCash(tx: Tx, seasonId: number, picked: readonly PickedTrade[]): Promise<Outcome[]> {
    const clubIds = [...new Set(picked.map((t) => t.clubId))];
    const events = await tx.db
      .select({ id: payoutEvents.id, clubId: payoutEvents.clubId, perShare: payoutEvents.perShare })
      .from(payoutEvents)
      .where(
        and(
          eq(payoutEvents.seasonId, seasonId),
          inArray(payoutEvents.clubId, clubIds),
          eq(payoutEvents.kind, "buyback"),
          inArray(payoutEvents.status, ["pending", "approved"]),
        ),
      );
    if (clubIds.some((id) => !events.some((e) => e.clubId === id))) throw fail("annul_not_allowed");
    const perShare = new Map(events.map((e) => [e.clubId, e.perShare]));
    const clubOfEvent = new Map(events.map((e) => [e.id, e.clubId]));
    const walletIds = [...new Set(picked.flatMap((t) => [t.buyerWalletId, t.sellerWalletId]))];
    const photo = await tx.db
      .select({ eventId: payoutHoldings.eventId, walletId: payoutHoldings.walletId, shares: payoutHoldings.shares })
      .from(payoutHoldings)
      .where(and(inArray(payoutHoldings.eventId, events.map((e) => e.id)), inArray(payoutHoldings.walletId, walletIds)));
    const shares = new Map(photo.map((h) => [holdingKey(h.walletId, clubOfEvent.get(h.eventId)!), h.shares]));
    const input: AnnulTrade[] = picked.map((t) => ({
      id: t.id,
      at: t.at.getTime(),
      clubId: t.clubId,
      buyerWallet: t.buyerWalletId,
      sellerWallet: t.sellerWalletId,
      quantity: t.quantity,
      price: t.price,
    }));
    const tickerOf = new Map(picked.map((t) => [t.clubId, t.ticker]));
    return planCashAnnulment(input, shares, perShare).steps.map((s) => ({
      tradeId: s.tradeId,
      clubId: s.clubId,
      ticker: tickerOf.get(s.clubId)!,
      price: s.price,
      buyerWallet: s.buyerWallet,
      sellerWallet: s.sellerWallet,
      returned: s.returned,
      short: s.short,
      buyerCash: s.buyerCash,
    }));
  }

  /**
   * Quem vai pagar mais que o caixa livre tem as compras abertas canceladas antes (`cancelBuysToCover` da F12, motivo
   * `annulment`). Conta o pior ponto no caminho, na ordem em que as linhas são gravadas (do negócio mais novo para o mais
   * antigo), e não só o total: uma linha que tira caixa antes de outra que devolve não pode passar do livre.
   */
  private async coverCash(tx: Tx, outcomes: readonly Outcome[], isLive: (walletId: number) => boolean): Promise<void> {
    const running = new Map<number, number>();
    const peak = new Map<number, number>();
    const move = (walletId: number, delta: number) => {
      if (!isLive(walletId)) return;
      const next = (running.get(walletId) ?? 0) + delta;
      running.set(walletId, next);
      peak.set(walletId, Math.max(peak.get(walletId) ?? 0, -next));
    };
    for (const o of outcomes) {
      move(o.buyerWallet, o.buyerCash);
      move(o.sellerWallet, -o.buyerCash);
    }
    for (const [walletId, owed] of [...peak].sort(([a], [b]) => a - b)) {
      if (owed > 0) await this.reversal.cancelBuysToCover(tx, walletId, owed, "annulment");
    }
  }

  /**
   * O custo e o resultado da posição depois da linha (proposta 18). Na carteira viva, `replayCost` sobre o extrato do
   * clube, com cada negócio anulado valendo só o que ficou (`current`, os deste caso até aqui, e as anulações
   * anteriores). Se o histórico refeito não fecha com as ações de agora (a compra anulada já tinha sido vendida e as
   * ações que voltam vieram de outra compra), e na tesouraria, a conta é a de um movimento comum: entrando, como compra
   * pelo preço do negócio; saindo, na proporção do custo, sem resultado.
   */
  private async annulledCost(
    tx: Tx,
    walletId: number,
    o: Outcome,
    sharesDelta: number,
    current: ReadonlyMap<number, number>,
    live: boolean,
  ): Promise<{ cost: Cents; realized: Cents }> {
    const [p] = await tx.db.select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, o.clubId)));
    const position = { shares: p?.shares ?? 0, cost: p?.cost ?? 0, realized: p?.realized ?? 0, dividends: 0 };
    if (live) {
      try {
        const replayed = replayCost(await this.history(tx, walletId, o.clubId), await this.remainingFor(tx, walletId, o.clubId, current));
        if (replayed.shares === position.shares + sharesDelta) return { cost: replayed.cost, realized: replayed.realized };
      } catch {
        // histórico que não se refaz sem ações negativas: vale a conta comum, abaixo
      }
    }
    if (sharesDelta > 0) {
      const after = buy(position, sharesDelta, o.price);
      return { cost: after.cost, realized: after.realized };
    }
    if (sharesDelta < 0) {
      const after = debitShares(position, -sharesDelta);
      return { cost: after.cost, realized: after.realized };
    }
    return { cost: position.cost, realized: position.realized };
  }

  /**
   * No modo em dinheiro as ações ficam: o custo não muda e o dinheiro entra no resultado. Para quem comprou, a
   * recompra das ações (pendente ou paga) somada a isto dá o resultado de quem nunca comprou; para quem vendeu, o de
   * quem teve as ações recompradas em vez de vendê-las.
   */
  private async cashCost(tx: Tx, walletId: number, clubId: number, cashDelta: number): Promise<{ cost: Cents; realized: Cents }> {
    const [p] = await tx.db.select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, clubId)));
    return { cost: p?.cost ?? 0, realized: (p?.realized ?? 0) + cashDelta };
  }

  /** O extrato da posição, na ordem em que aconteceu, como o `replayCost` lê (sem as linhas `trade_annulled`). */
  private async history(tx: Tx, walletId: number, clubId: number): Promise<ReplayEntry[]> {
    const rows = await tx.db
      .select({ kind: walletEntries.kind, sharesDelta: walletEntries.sharesDelta, price: walletEntries.price, refType: walletEntries.refType, refId: walletEntries.refId })
      .from(walletEntries)
      .where(and(eq(walletEntries.walletId, walletId), eq(walletEntries.clubId, clubId)))
      .orderBy(asc(walletEntries.id));
    return rows
      .filter((r) => r.kind !== "trade_annulled" && r.sharesDelta !== 0)
      .map((r) => ({
        sharesDelta: r.sharesDelta,
        ...(r.price !== null ? { price: r.price } : {}),
        // saem sem resultado: o débito do admin e as ações da conta excluída indo para a tesouraria
        ...(r.sharesDelta < 0 && (r.kind === "adjustment" || r.kind === "account_deleted") ? { debit: true } : {}),
        ...(r.kind === "trade" && r.refType === TRADE_REF && r.refId !== null ? { tradeId: Number(r.refId) } : {}),
      }));
  }

  /** O que ficou de cada negócio anulado da posição: os anulados antes (o que faltou) e os deste caso até aqui. */
  private async remainingFor(tx: Tx, walletId: number, clubId: number, current: ReadonlyMap<number, number>): Promise<Map<number, number>> {
    const rows = await tx.db
      .select({ tradeId: tradeAnnulments.tradeId, short: tradeAnnulments.sharesShort })
      .from(tradeAnnulments)
      .innerJoin(trades, eq(trades.id, tradeAnnulments.tradeId))
      .where(and(eq(trades.clubId, clubId), sql`(${trades.buyerWalletId} = ${walletId} or ${trades.sellerWalletId} = ${walletId})`));
    const out = new Map(rows.map((r) => [Number(r.tradeId), r.short]));
    for (const [id, short] of current) out.set(id, short);
    return out;
  }

  /** As ações livres (fora das vendas abertas) de cada carteira em cada clube dos negócios. */
  private async freeShares(tx: Tx, input: readonly AnnulTrade[]): Promise<Map<string, number>> {
    const walletIds = [...new Set(input.flatMap((t) => [t.buyerWallet, t.sellerWallet]))];
    const clubIds = [...new Set(input.map((t) => t.clubId))];
    const out = new Map<string, number>();
    if (walletIds.length === 0) return out;
    const rows = await tx.db
      .select({ walletId: positions.walletId, clubId: positions.clubId, shares: positions.shares, reserved: positions.reservedShares })
      .from(positions)
      .where(and(inArray(positions.walletId, walletIds), inArray(positions.clubId, clubIds)));
    for (const r of rows) out.set(holdingKey(r.walletId, r.clubId), r.shares - r.reserved);
    return out;
  }

  /** O caso, ainda aberto. */
  private async caseOf(tx: Tx, caseId: number): Promise<CaseRow> {
    const [c] = await tx.db.select().from(fraudCases).where(eq(fraudCases.id, caseId));
    if (!c) throw fail("case_not_found");
    if (c.status !== "open") throw fail("case_already_decided");
    return c;
  }

  /** Marca a decisão só se o caso ainda está aberto: a segunda decisão do mesmo caso não acha linha. */
  private async decide(tx: Tx, caseId: number, status: "confirmed" | "dismissed", adminId: string, reason: string, now: Date): Promise<CaseRow> {
    const [c] = await tx.db
      .update(fraudCases)
      .set({ status, decidedBy: adminId, decidedAt: now, decisionReason: reason })
      .where(and(eq(fraudCases.id, caseId), eq(fraudCases.status, "open")))
      .returning();
    if (!c) throw fail("case_already_decided");
    return c;
  }

  /** As duas contas do caso, com o estado da conta lido agora. */
  private async parties(tx: Tx, c: CaseRow): Promise<Party[]> {
    const rows = await tx.db
      .select({ id: wallets.id, ownerType: wallets.ownerType, userId: wallets.userId, status: users.status, nickname: users.nickname })
      .from(wallets)
      .leftJoin(users, eq(users.id, wallets.userId))
      .where(inArray(wallets.id, [c.walletLow, c.walletHigh]));
    return rows.map((r): Party => {
      if (r.ownerType === "bot") return { walletId: r.id, kind: "bot", userId: null, nickname: null };
      if (r.userId && r.status !== "deleted") return { walletId: r.id, kind: "player", userId: r.userId, nickname: r.nickname };
      return { walletId: r.id, kind: "deleted", userId: null, nickname: null };
    });
  }

  /** Os usuários das contas já excluídas do caso (a linha continua, sem dados): travados junto, para a ordem ser a mesma. */
  private async deletedUsersOf(tx: Tx, c: CaseRow): Promise<string[]> {
    const rows = await tx.db
      .select({ userId: wallets.userId })
      .from(wallets)
      .innerJoin(users, eq(users.id, wallets.userId))
      .where(and(inArray(wallets.id, [c.walletLow, c.walletHigh]), eq(users.status, "deleted")));
    return rows.flatMap((r) => (r.userId ? [r.userId] : []));
  }

  /**
   * Os negócios marcados: todos do caso, sem repetição e nenhum já anulado (`trade_not_annullable`), do mais antigo para
   * o mais novo.
   */
  private async pickedTrades(tx: Tx, c: CaseRow, tradeIds: readonly number[]): Promise<PickedTrade[]> {
    if (new Set(tradeIds).size !== tradeIds.length) throw tradeNotAnnullable();
    const rows = await tx.db
      .select({
        id: trades.id,
        at: trades.at,
        clubId: trades.clubId,
        ticker: sql<string>`${clubs.ticker}`,
        quantity: trades.quantity,
        price: trades.price,
        buyerWalletId: trades.buyerWalletId,
        sellerWalletId: trades.sellerWalletId,
        annulled: tradeAnnulments.tradeId,
      })
      .from(fraudCaseTrades)
      .innerJoin(trades, eq(trades.id, fraudCaseTrades.tradeId))
      .innerJoin(clubs, eq(clubs.id, trades.clubId))
      .leftJoin(tradeAnnulments, eq(tradeAnnulments.tradeId, trades.id))
      .where(and(eq(fraudCaseTrades.caseId, c.id), inArray(fraudCaseTrades.tradeId, [...tradeIds])));
    if (rows.length !== tradeIds.length || rows.some((r) => r.annulled !== null)) throw tradeNotAnnullable();
    return rows
      .map((r) => ({
        id: r.id,
        at: r.at,
        clubId: r.clubId,
        ticker: r.ticker,
        quantity: r.quantity,
        price: r.price,
        buyerWalletId: r.buyerWalletId,
        sellerWalletId: r.sellerWalletId,
      }))
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  }

  private async treasuryOf(tx: Tx, seasonId: number): Promise<number> {
    const [t] = await tx.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
    if (!t) throw new Error(`temporada ${seasonId} sem tesouraria: a conta excluída não tem quem fique no lugar dela`);
    return t.id;
  }
}
