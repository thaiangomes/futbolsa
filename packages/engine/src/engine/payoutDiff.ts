import type { Cents } from "./money.js";
import type { PayoutEvent, PayoutEventKind } from "./payoutEvents.js";

/**
 * Diferença de pagamentos na correção de um resultado ([[Admin]]): compara a
 * versão antiga dos eventos com a nova (a prévia que o admin vê antes de aplicar)
 * e calcula, por carteira, o estorno de quem recebeu a mais e o complemento de
 * quem recebeu a menos, pela posição no fechamento do evento.
 *
 * É a base do estorno com caixa negativo: aqui só a conta; cancelar as compras
 * abertas para cobrir o estorno e gravar o extrato é de quem chama.
 */

export interface PayoutChange {
  /** Chave do evento, a mesma nas duas versões. */
  key: string;
  kind: PayoutEventKind;
  clubId: string;
  competition: string;
  stage: string;
  /** Motivo da versão nova (ou da antiga, se o evento sumiu). */
  reason: string;
  /** Valor por ação antes da correção (zero se o evento não existia). */
  before: Cents;
  /** Valor por ação depois da correção (zero se o evento sumiu). */
  after: Cents;
  /** `after − before`: positivo é complemento, negativo é estorno. */
  delta: Cents;
  closedAtBefore?: number;
  closedAtAfter?: number;
}

function indexByKey(events: readonly PayoutEvent[], label: string): Map<string, PayoutEvent> {
  const map = new Map<string, PayoutEvent>();
  for (const e of events) {
    if (map.has(e.key)) throw new Error(`Chave de evento repetida na versão ${label}: ${e.key}`);
    map.set(e.key, e);
  }
  return map;
}

/**
 * Casa os eventos das duas versões pela chave e devolve os que mudaram (valor por
 * ação ou instante de fechamento). Evento novo tem `before` zero; evento que sumiu,
 * `after` zero.
 */
export function diffEvents(before: readonly PayoutEvent[], after: readonly PayoutEvent[]): PayoutChange[] {
  const oldByKey = indexByKey(before, "antiga");
  const newByKey = indexByKey(after, "nova");
  const changes: PayoutChange[] = [];

  for (const key of new Set([...oldByKey.keys(), ...newByKey.keys()])) {
    const old = oldByKey.get(key);
    const next = newByKey.get(key);
    const reference = (next ?? old)!;
    const beforeValue = old?.perShare ?? 0;
    const afterValue = next?.perShare ?? 0;
    if (old && next && beforeValue === afterValue && old.closedAt === next.closedAt) continue;
    changes.push({
      key,
      kind: reference.kind,
      clubId: reference.clubId,
      competition: reference.competition,
      stage: reference.stage,
      reason: reference.reason,
      before: beforeValue,
      after: afterValue,
      delta: afterValue - beforeValue,
      ...(old ? { closedAtBefore: old.closedAt } : {}),
      ...(next ? { closedAtAfter: next.closedAt } : {}),
    });
  }

  return changes.sort(
    (a, b) =>
      (a.closedAtAfter ?? a.closedAtBefore ?? 0) - (b.closedAtAfter ?? b.closedAtBefore ?? 0) ||
      a.clubId.localeCompare(b.clubId) ||
      a.key.localeCompare(b.key),
  );
}

export interface WalletAdjustmentItem {
  key: string;
  clubId: string;
  /** Complemento (a carteira recebe a mais) ou estorno (devolve). */
  kind: "complement" | "reversal";
  /** Ações na foto × diferença por ação, com sinal. */
  amount: Cents;
  perShareDelta: Cents;
  reason: string;
}

export interface WalletAdjustment {
  walletId: string;
  /** Soma dos itens: positivo cai no caixa, negativo sai dele (e o caixa pode ficar negativo). */
  amount: Cents;
  /** Uma linha do extrato por estorno ou complemento. */
  items: WalletAdjustmentItem[];
}

/**
 * Valor a creditar (complemento) ou debitar (estorno) em cada carteira.
 * `holdings(mudança)` devolve as ações de cada carteira na foto do fechamento do
 * evento: a original, para evento que existia; a do fechamento dele, para evento
 * novo. Carteiras ordenadas por id.
 */
export function settle(
  changes: readonly PayoutChange[],
  holdings: (change: PayoutChange) => ReadonlyMap<string, number>,
): WalletAdjustment[] {
  const byWallet = new Map<string, WalletAdjustment>();
  for (const change of changes) {
    if (change.delta === 0) continue;
    for (const [walletId, shares] of holdings(change)) {
      if (!Number.isInteger(shares) || shares < 0) {
        throw new Error(`Ações inválidas na foto de ${walletId} para ${change.key}: ${shares}`);
      }
      if (shares === 0) continue;
      const amount = shares * change.delta;
      const adjustment = byWallet.get(walletId) ?? { walletId, amount: 0, items: [] };
      adjustment.amount += amount;
      adjustment.items.push({
        key: change.key,
        clubId: change.clubId,
        kind: amount > 0 ? "complement" : "reversal",
        amount,
        perShareDelta: change.delta,
        reason: change.reason,
      });
      byWallet.set(walletId, adjustment);
    }
  }
  return [...byWallet.values()].sort((a, b) => a.walletId.localeCompare(b.walletId));
}
