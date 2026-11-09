import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type CorrectionChange, type CorrectionPreview } from "@futbolsa/contracts";
import {
  diffEvents,
  monthKey,
  type PayoutChange,
  type PayoutEvent,
  type PayoutEventKind,
  settle,
  type WalletAdjustmentItem,
} from "@futbolsa/engine";
import { clubs, orders, payoutEvents, payoutHoldings, seasons, users, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { CLOSE_MARGIN_MS, DIVIDEND_EVENTS, groupOfKey, roundAndPhase } from "./close-events.service.js";
import { EngineInputService } from "./engine-input.js";
import { type Executor, executorOf, type Holding, holdingsAt } from "./holdings.js";
import { settlingEventIds } from "./settlement.js";

export type CorrectionOutcome = CorrectionChange["outcome"];

/** A versão vigente aprovada que a correção substitui. */
export interface CurrentVersion {
  id: number;
  version: number;
  perShare: number;
  closedAt: Date;
  reason: string;
}

/**
 * A foto da versão nova: copiada da vigente quando o fechamento não muda (quem recebe também não), ou tirada de novo
 * no fechamento novo (evento novo, ou fechamento que mudou). A foto nova é a completa, como a da passada de
 * fechamento: inclui a conta excluída (a foto é o que era; quem não recebe é decisão do pagamento, P6).
 */
export type PlannedPhoto = { kind: "copy"; fromEventId: number } | { kind: "new"; holdings: Holding[] };

/** Uma mudança por evento e clube, com o que a T7 grava. */
export interface PlannedEvent {
  key: string;
  /** `clubs.id`. */
  clubId: number;
  /** O id do clube no motor (o ticker). */
  ticker: string;
  outcome: CorrectionOutcome;
  /** A versão vigente aprovada a substituir; `null` no evento novo numa rodada ou fase já paga. */
  current: CurrentVersion | null;
  /** A versão nova a gravar já `approved` (no evento que sumiu, o mesmo evento com R$ 0,00 e o fechamento antigo). */
  next: PayoutEvent;
  /** A diferença do motor (`diffEvents`). */
  change: PayoutChange;
  /**
   * As linhas passadas ao `settle`: uma só quando o fechamento não muda (ou o evento é novo, ou sumiu); duas quando
   * muda, o estorno do valor antigo pela foto antiga (antes → 0) e o pagamento do novo pela foto nova (0 → depois),
   * porque o `settle` ignora diferença zero e cada uma tem a sua foto.
   */
  lines: PayoutChange[];
  photo: PlannedPhoto;
  /** Ações de jogadores e bots na foto que paga o valor novo (a antiga no evento que sumiu). */
  shares: number;
  /** O que a correção move em R$ neste evento (a soma das linhas). */
  total: number;
}

/** O que uma carteira recebe ou devolve num evento: o líquido e as linhas do `settle` que o formam. */
export interface PlannedWalletEvent {
  key: string;
  clubId: number;
  /** Líquido da carteira nesta chave: positivo é complemento, negativo é estorno (o `payout_credits` da versão nova). */
  amount: number;
  items: WalletAdjustmentItem[];
}

/** O ajuste de uma carteira (jogador, inclusive bloqueado, ou bot; nunca a tesouraria nem a conta excluída). */
export interface PlannedWallet {
  walletId: number;
  ownerType: "user" | "bot";
  /** O caixa e o reservado na hora do plano (a T7 relê com a carteira travada). */
  cash: number;
  reservedCash: number;
  /** O líquido da carteira na correção inteira. */
  amount: number;
  events: PlannedWalletEvent[];
  /** O caixa livre (`cash − reservado`) não cobre o que ela devolve: as compras abertas serão canceladas (P5). */
  cancelBuys: boolean;
  /** Compras abertas da carteira (contadas só quando `cancelBuys`; senão 0). */
  openBuys: number;
  /** O caixa depois da correção (com as compras canceladas, se for o caso): pode ficar negativo. */
  cashAfter: number;
}

/** O plano da correção: o que a prévia mostra e o que a T7 aplica sem refazer a conta. */
export interface CorrectionPlan {
  seasonId: number;
  planCode: string;
  events: PlannedEvent[];
  /** Em ordem de carteira. */
  wallets: PlannedWallet[];
  /** Os fechamentos antigos e novos das versões trocadas, sem repetição e em ordem (para o `RankingsPort`). */
  closedAts: Date[];
  preview: CorrectionPreview;
}

type EventRow = typeof payoutEvents.$inferSelect;

const DIVIDEND_KINDS: readonly string[] = DIVIDEND_EVENTS.kinds;

/** O evento gravado no formato do motor, para o `diffEvents` (o `stage` sai da chave `tipo|competição|stage|clube`). */
function toPayoutEvent(row: EventRow, ticker: string): PayoutEvent {
  return {
    key: row.eventKey,
    kind: row.kind as PayoutEventKind,
    clubId: ticker,
    competition: row.competition ?? "",
    stage: row.eventKey.split("|")[2] ?? "",
    perShare: row.perShare,
    closedAt: row.closedAt.getTime(),
    reason: row.reason,
  };
}

/** JSON com as chaves dos objetos em ordem, para o código do plano não depender da ordem de montagem. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const byNumber = (a: number, b: number) => a - b;

/**
 * O plano da correção depois de pago (Plano dos dividendos e pagamentos, T6; Admin, "Correção depois de pago",
 * critérios 11, 12, 13, 17 e 18). Só lê: compara as versões vigentes aprovadas com o que os resultados atuais dão
 * (`eventsFor`), decide o que entra na correção, calcula por carteira com o `settle` do motor e a foto, e devolve a
 * prévia com o código que a aplicação (T7) confere.
 *
 * O que entra:
 * - evento aprovado com valor ou fechamento diferente (`correction`);
 * - evento aprovado que sumiu do resultado: vai a R$ 0,00, para o estorno ter um evento ao qual se ligar (`vanished`);
 * - evento novo numa rodada ou fase (o grupo da passada de fechamento) que já tem evento aprovado, com o fechamento
 *   fora da margem de 2 minutos: é pago na própria correção, sem nova aprovação (P4, critério 13; `new_in_paid_group`).
 *   Evento novo de grupo sem aprovação não entra: a passada de fechamento o grava como `pending`.
 *
 * Quem recebe e quem devolve: pela foto original (a da versão vigente) no evento que existia, pela foto do fechamento
 * no evento novo; com o fechamento mudado, o estorno do valor antigo sai pela foto antiga e o valor novo pela nova.
 * Recebem e devolvem os jogadores (inclusive os bloqueados) e os bots; a tesouraria nunca está na foto, e a conta
 * excluída não recebe nem devolve (P6). O caixa pode ficar negativo; quem tem o caixa livre menor que o que devolve
 * tem as compras abertas canceladas (P5), e a prévia conta quantas.
 */
@Injectable()
export class CorrectionPlanService {
  constructor(private readonly engineInput: EngineInputService) {}

  async plan(executor: Executor, seasonId: number, now: Date): Promise<CorrectionPlan> {
    const db = executorOf(executor);
    const [season] = await db.select({ status: seasons.status }).from(seasons).where(eq(seasons.id, seasonId));
    if (!season) throw new DomainError("no_season", 409, ADMIN_ERROR_MESSAGES.no_season);
    // depois de encerrada, os resultados da temporada não aceitam mais correção (critério 18)
    if (season.status === "closed") throw new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);
    // o estorno não é calculado sobre um pagamento pela metade
    if ((await settlingEventIds(executor, seasonId)).length > 0) {
      throw new DomainError("payout_settling", 409, ADMIN_ERROR_MESSAGES.payout_settling);
    }

    // o que os resultados atuais dão (só os dividendos: a recompra é da F15)
    const loaded = await this.engineInput.load(executor, seasonId);
    const computed = new Map<string, PayoutEvent>();
    for (const event of DIVIDEND_EVENTS.events(loaded)) {
      if (DIVIDEND_KINDS.includes(event.kind)) computed.set(event.key, event);
    }

    const current = await db
      .select()
      .from(payoutEvents)
      .where(
        and(eq(payoutEvents.seasonId, seasonId), ne(payoutEvents.status, "superseded"), inArray(payoutEvents.kind, [...DIVIDEND_KINDS])),
      );
    const currentKeys = new Set(current.map((r) => r.eventKey));
    const approved = new Map(current.filter((r) => r.status === "approved").map((r) => [r.eventKey, r]));
    const approvedGroups = new Set([...approved.keys()].map(groupOfKey));

    // `before`: as versões aprovadas; `after`: o resultado atual restrito às chaves aprovadas e às novas de grupo pago
    const limit = now.getTime() - CLOSE_MARGIN_MS;
    const before: PayoutEvent[] = [];
    const after: PayoutEvent[] = [];
    for (const row of approved.values()) {
      const old = toPayoutEvent(row, loaded.tickerOf(row.clubId));
      const next = computed.get(row.eventKey);
      if (!next) {
        // já foi a R$ 0,00 numa correção anterior e continua fora do resultado: nada a corrigir
        if (row.perShare > 0) before.push(old);
        continue;
      }
      // o fechamento novo ainda está na margem (ou no futuro): a foto dele ainda não pode ser tirada, espera
      if (next.closedAt !== old.closedAt && next.closedAt > limit) continue;
      before.push(old);
      after.push(next);
    }
    for (const [key, event] of computed) {
      if (currentKeys.has(key) || !approvedGroups.has(groupOfKey(key)) || event.closedAt > limit) continue;
      after.push(event);
    }
    const afterByKey = new Map(after.map((e) => [e.key, e]));
    const changes = diffEvents(before, after);

    // as mudanças por evento e clube, com as linhas do `settle` e a foto de cada uma
    const photos = new Map<PayoutChange, Holding[]>();
    const events: PlannedEvent[] = [];
    const paying = new Map<PlannedEvent, Holding[]>();
    for (const change of changes) {
      const row = approved.get(change.key) ?? null;
      const clubId = row?.clubId ?? loaded.clubIdOf(change.clubId);
      const outcome: CorrectionOutcome = !row ? "new_in_paid_group" : change.closedAtAfter === undefined ? "vanished" : "correction";
      const next = afterByKey.get(change.key) ?? { ...toPayoutEvent(row!, change.clubId), perShare: 0 };
      const oldPhoto = row ? await this.originalPhoto(executor, row.id) : [];
      const sameClose = row !== null && next.closedAt === row.closedAt.getTime();
      let photo: PlannedPhoto;
      let lines: PayoutChange[];
      let payingPhoto: Holding[];
      if (sameClose) {
        // o fechamento não mudou (ou o evento sumiu): a foto original paga a diferença inteira
        photo = { kind: "copy", fromEventId: row!.id };
        lines = [change];
        photos.set(change, oldPhoto);
        payingPhoto = oldPhoto;
      } else {
        const newPhoto = await holdingsAt(executor, seasonId, clubId, new Date(next.closedAt));
        photo = { kind: "new", holdings: newPhoto };
        payingPhoto = newPhoto;
        if (row) {
          // fechamento mudado: o estorno do antigo pela foto antiga e o pagamento do novo pela nova
          const reversal: PayoutChange = { ...change, after: 0, delta: -change.before };
          delete reversal.closedAtAfter;
          const complement: PayoutChange = { ...change, before: 0, delta: change.after };
          delete complement.closedAtBefore;
          lines = [reversal, complement];
          photos.set(reversal, oldPhoto);
          photos.set(complement, newPhoto);
        } else {
          lines = [change];
          photos.set(change, newPhoto);
        }
      }
      const planned: PlannedEvent = {
        key: change.key,
        clubId,
        ticker: change.clubId,
        outcome,
        current: row
          ? { id: row.id, version: row.version, perShare: row.perShare, closedAt: row.closedAt, reason: row.reason }
          : null,
        next,
        change,
        lines,
        photo,
        shares: 0,
        total: 0,
      };
      paying.set(planned, payingPhoto);
      events.push(planned);
    }

    // quem recebe e devolve: jogadores (inclusive bloqueados) e bots; a conta excluída fica fora (P6)
    const photoWallets = [...new Set([...photos.values()].flatMap((p) => p.map((h) => h.walletId)))];
    const walletRows =
      photoWallets.length === 0
        ? []
        : await db
            .select({
              id: wallets.id,
              ownerType: wallets.ownerType,
              cash: wallets.cash,
              reservedCash: wallets.reservedCash,
              userStatus: users.status,
            })
            .from(wallets)
            .leftJoin(users, eq(users.id, wallets.userId))
            .where(inArray(wallets.id, photoWallets));
    const walletInfo = new Map(walletRows.map((w) => [w.id, w]));
    const receives = (walletId: number) => {
      const w = walletInfo.get(walletId);
      return !!w && (w.ownerType === "bot" || (w.ownerType === "user" && w.userStatus !== "deleted"));
    };
    const receiving = (holdings: readonly Holding[]) =>
      new Map(holdings.filter((h) => receives(h.walletId)).map((h) => [String(h.walletId), h.shares]));

    for (const planned of events) {
      planned.shares = paying.get(planned)!.filter((h) => receives(h.walletId)).reduce((sum, h) => sum + h.shares, 0);
      planned.total = planned.lines.reduce(
        (sum, line) => sum + photos.get(line)!.filter((h) => receives(h.walletId)).reduce((s, h) => s + h.shares * line.delta, 0),
        0,
      );
    }

    const lines = events.flatMap((e) => e.lines);
    const adjustments = settle(lines, (line) => receiving(photos.get(line)!));
    const clubOfKey = new Map(events.map((e) => [e.key, e.clubId]));
    const planWallets: PlannedWallet[] = adjustments
      .map((adjustment) => {
        const walletId = Number(adjustment.walletId);
        const info = walletInfo.get(walletId)!;
        const byKey = new Map<string, PlannedWalletEvent>();
        for (const item of adjustment.items) {
          let entry = byKey.get(item.key);
          if (!entry) byKey.set(item.key, (entry = { key: item.key, clubId: clubOfKey.get(item.key)!, amount: 0, items: [] }));
          entry.amount += item.amount;
          entry.items.push(item);
        }
        const cancelBuys = adjustment.amount < 0 && info.cash - info.reservedCash + adjustment.amount < 0;
        return {
          walletId,
          ownerType: info.ownerType as "user" | "bot",
          cash: info.cash,
          reservedCash: info.reservedCash,
          amount: adjustment.amount,
          events: [...byKey.values()],
          cancelBuys,
          openBuys: 0,
          cashAfter: info.cash + adjustment.amount,
        };
      })
      .sort((a, b) => a.walletId - b.walletId);

    // compras abertas das carteiras cujo caixa livre não cobre o estorno: a T7 as cancela (P5)
    const toCancel = planWallets.filter((w) => w.cancelBuys).map((w) => w.walletId);
    if (toCancel.length > 0) {
      const counts = await db
        .select({ walletId: orders.walletId, n: sql<number>`count(*)::int` })
        .from(orders)
        .where(and(inArray(orders.walletId, toCancel), eq(orders.side, "buy"), eq(orders.status, "open")))
        .groupBy(orders.walletId);
      const byWallet = new Map(counts.map((c) => [c.walletId, c.n]));
      for (const w of planWallets) if (w.cancelBuys) w.openBuys = byWallet.get(w.walletId) ?? 0;
    }

    const instants = [...new Set(changes.flatMap((c) => [c.closedAtBefore, c.closedAtAfter]).filter((x): x is number => x !== undefined))].sort(
      byNumber,
    );
    const clubRows =
      events.length === 0
        ? []
        : await db
            .select({ id: clubs.id, ticker: clubs.ticker, name: clubs.name })
            .from(clubs)
            .where(inArray(clubs.id, [...new Set(events.map((e) => e.clubId))]));
    const clubById = new Map(clubRows.map((c) => [c.id, c]));

    const planCode = createHash("sha256")
      .update(
        canonicalJson({
          seasonId,
          changes: [...events]
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .map((e) => ({
              key: e.key,
              clubId: e.clubId,
              currentId: e.current?.id ?? null,
              currentVersion: e.current?.version ?? null,
              before: e.change.before,
              after: e.change.after,
              closedAtBefore: e.change.closedAtBefore ?? null,
              closedAtAfter: e.change.closedAtAfter ?? null,
            })),
          wallets: planWallets.map((w) => ({ walletId: w.walletId, amount: w.amount })),
        }),
      )
      .digest("hex");

    const preview: CorrectionPreview = {
      planCode,
      changes: events.map((e): CorrectionChange => {
        const club = clubById.get(e.clubId)!;
        return {
          key: e.key,
          kind: e.change.kind as CorrectionChange["kind"],
          club: { id: club.id, ticker: club.ticker, name: club.name },
          competition: (e.change.competition || null) as CorrectionChange["competition"],
          ...roundAndPhase(e.next),
          reason: e.change.reason,
          before: e.change.before,
          after: e.change.after,
          delta: e.change.delta,
          closedAtBefore: e.change.closedAtBefore === undefined ? null : new Date(e.change.closedAtBefore).toISOString(),
          closedAtAfter: e.change.closedAtAfter === undefined ? null : new Date(e.change.closedAtAfter).toISOString(),
          shares: e.shares,
          total: e.total,
          outcome: e.outcome,
        };
      }),
      wallets: {
        receive: planWallets.filter((w) => w.amount > 0).length,
        pay: planWallets.filter((w) => w.amount < 0).length,
        negative: planWallets.filter((w) => w.cashAfter < 0).length,
        buysCancelled: planWallets.reduce((sum, w) => sum + w.openBuys, 0),
      },
      // os meses de ranking (Brasília) do fechamento antigo e do novo de cada mudança, inclusive os já fechados
      months: [...new Set(instants.map(monthKey))].sort(),
    };

    return { seasonId, planCode, events, wallets: planWallets, closedAts: instants.map((ms) => new Date(ms)), preview };
  }

  /** A foto da versão aprovada vigente (`payout_holdings`, imutável), em ordem de carteira. */
  private async originalPhoto(executor: Executor, eventId: number): Promise<Holding[]> {
    return executorOf(executor)
      .select({ walletId: payoutHoldings.walletId, shares: payoutHoldings.shares })
      .from(payoutHoldings)
      .where(eq(payoutHoldings.eventId, eventId))
      .orderBy(asc(payoutHoldings.walletId));
  }
}
