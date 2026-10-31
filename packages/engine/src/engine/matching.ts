import type { Cents } from "./money.js";
import type { OrderType, Side } from "./orderbook.js";

/**
 * Núcleo de casamento puro: recebe o lado oposto do livro de um clube e a ordem
 * que chega e devolve os negócios e o que sobra da ordem, sem mexer em nada.
 * Quem chama aplica o resultado: o `Exchange` na simulação, a API no banco,
 * dentro da transação com o clube travado (Arquitetura da Fase 1).
 *
 * - Prioridade preço-tempo: o lado oposto chega em ordem (melhor preço; no
 *   empate, menor id, que é a ordem mais antiga).
 * - O negócio sai pelo preço da ordem que estava no livro.
 * - Compra a mercado não tem reserva: executa até o caixa livre.
 * - Ordem contra si mesmo: "skip" pula as próprias ordens (simulação calibrada
 *   da Fase 0); "reject" recusa a ordem sem nenhum negócio (o jogo).
 */

export type SelfTradeMode = "skip" | "reject";

export interface RestingOrder {
  id: number;
  accountId: string;
  side: Side;
  limitPrice: Cents;
  remaining: number;
}

export interface IncomingOrder {
  id: number;
  accountId: string;
  side: Side;
  type: OrderType;
  quantity: number;
  /** Obrigatório em ordem limitada, em centavos. */
  limitPrice?: Cents;
}

export interface MatchContext {
  selfTrade: SelfTradeMode;
  /** Caixa livre de quem manda uma compra a mercado (ela não tem reserva). */
  availableCash?: Cents;
  /** Teto da compra a mercado ou piso da venda a mercado (os 20% do envio). Sem ele, não há limite. */
  marketPriceLimit?: Cents;
}

export interface Fill {
  restingId: number;
  price: Cents;
  quantity: number;
  buyerId: string;
  sellerId: string;
  buyOrderId: number;
  sellOrderId: number;
}

export type MatchStatus = "filled" | "partial" | "resting" | "cancelled" | "rejected";

export interface MatchResult {
  status: MatchStatus;
  reason?: "self_trade";
  /** Na ordem em que saíram. */
  fills: Fill[];
  /** O que sobrou da ordem que chegou. */
  remaining: number;
  /** A sobra fica no livro (limitada) ou é cancelada (a mercado, ou recusada). */
  rests: boolean;
}

/** Variação nos saldos de uma conta num clube. */
export interface BalanceDelta {
  cash: Cents;
  reservedCash: Cents;
  shares: number;
  reservedShares: number;
}

const ZERO: BalanceDelta = { cash: 0, reservedCash: 0, shares: 0, reservedShares: 0 };

/**
 * Se a ordem cruzaria com uma ordem aberta da mesma conta no mesmo clube:
 * compra limitada com preço igual ou acima de uma venda minha, venda limitada
 * com preço igual ou abaixo de uma compra minha, ou ordem a mercado com
 * qualquer ordem minha do lado oposto.
 */
export function selfTradeConflict(
  order: Pick<IncomingOrder, "side" | "type" | "limitPrice">,
  myOpenOrders: readonly Pick<RestingOrder, "side" | "limitPrice">[],
): boolean {
  const opposite = myOpenOrders.filter((o) => o.side !== order.side);
  if (order.type === "market") return opposite.length > 0;
  return opposite.some((o) => (order.side === "buy" ? order.limitPrice! >= o.limitPrice : order.limitPrice! <= o.limitPrice));
}

export function matchOrder(opposite: readonly RestingOrder[], incoming: IncomingOrder, ctx: MatchContext): MatchResult {
  if (!Number.isSafeInteger(incoming.quantity) || incoming.quantity <= 0) throw new Error("Quantidade inválida no casamento");
  if (incoming.type === "limit" && incoming.limitPrice === undefined) throw new Error("Ordem limitada sem preço no casamento");

  if (ctx.selfTrade === "reject" && selfTradeConflict(incoming, opposite.filter((o) => o.accountId === incoming.accountId))) {
    return { status: "rejected", reason: "self_trade", fills: [], remaining: incoming.quantity, rests: false };
  }

  const buying = incoming.side === "buy";
  const marketBuy = buying && incoming.type === "market";
  let cash = ctx.availableCash ?? 0;
  if (marketBuy && ctx.availableCash === undefined) throw new Error("Compra a mercado sem o caixa livre no contexto");

  const fills: Fill[] = [];
  let remaining = incoming.quantity;
  let previous: RestingOrder | undefined;
  for (const resting of opposite) {
    if (remaining === 0) break;
    if (resting.side === incoming.side) throw new Error("Ordem do mesmo lado no livro oposto");
    if (previous && !inPriorityOrder(previous, resting)) throw new Error("Livro fora da ordem de prioridade");
    previous = resting;

    const price = resting.limitPrice;
    const limit = incoming.type === "limit" ? incoming.limitPrice : ctx.marketPriceLimit;
    if (limit !== undefined && (buying ? price > limit : price < limit)) break;

    if (resting.accountId === incoming.accountId) {
      // No modo reject o conflito já foi recusado acima; chegar aqui é erro de quem chamou.
      if (ctx.selfTrade === "skip") continue;
      throw new Error("Ordem própria no caminho do casamento");
    }

    let quantity = Math.min(remaining, resting.remaining);
    if (marketBuy) {
      quantity = Math.min(quantity, Math.floor(Math.max(0, cash) / price));
      if (quantity <= 0) break;
      cash -= price * quantity;
    }

    fills.push({
      restingId: resting.id,
      price,
      quantity,
      buyerId: buying ? incoming.accountId : resting.accountId,
      sellerId: buying ? resting.accountId : incoming.accountId,
      buyOrderId: buying ? incoming.id : resting.id,
      sellOrderId: buying ? resting.id : incoming.id,
    });
    remaining -= quantity;
  }

  const rests = remaining > 0 && incoming.type === "limit";
  const status: MatchStatus =
    remaining === 0 ? "filled" : fills.length ? "partial" : incoming.type === "limit" ? "resting" : "cancelled";
  return { status, fills, remaining, rests };
}

/** `a` vem antes de `b` no mesmo lado do livro: melhor preço e, no empate, menor id. */
function inPriorityOrder(a: RestingOrder, b: RestingOrder): boolean {
  if (a.limitPrice !== b.limitPrice) return a.side === "sell" ? a.limitPrice < b.limitPrice : a.limitPrice > b.limitPrice;
  return a.id < b.id;
}

/** O que a ordem prende ao entrar: compra limitada prende quantidade × limite; venda prende as ações. */
export function entryReservation(order: Pick<IncomingOrder, "side" | "type" | "quantity" | "limitPrice">): BalanceDelta {
  if (order.side === "sell") return { ...ZERO, reservedShares: order.quantity };
  if (order.type === "limit") return { ...ZERO, reservedCash: order.quantity * order.limitPrice! };
  return { ...ZERO };
}

/**
 * Liquidação de um negócio. O comprador solta a reserva da parte executada (se
 * a compra era limitada), paga o preço do negócio e recebe as ações; a diferença
 * entre o limite e o preço volta para o livre. O vendedor solta e entrega as
 * ações reservadas e recebe o dinheiro.
 */
export function settlement(
  fill: Pick<Fill, "price" | "quantity">,
  buyOrder: { type: OrderType; limitPrice?: Cents },
): { buyer: BalanceDelta; seller: BalanceDelta } {
  const value = fill.price * fill.quantity;
  return {
    buyer: {
      cash: -value,
      reservedCash: buyOrder.type === "limit" ? -fill.quantity * buyOrder.limitPrice! : 0,
      shares: fill.quantity,
      reservedShares: 0,
    },
    seller: { cash: value, reservedCash: 0, shares: -fill.quantity, reservedShares: -fill.quantity },
  };
}

/** Devolve a reserva do que não executou (cancelamento ou sobra da ordem a mercado). */
export function remainderRelease(order: Pick<IncomingOrder, "side" | "type" | "limitPrice">, remaining: number): BalanceDelta {
  if (remaining === 0) return { ...ZERO };
  if (order.side === "sell") return { ...ZERO, reservedShares: -remaining };
  if (order.type === "limit") return { ...ZERO, reservedCash: -remaining * order.limitPrice! };
  return { ...ZERO };
}
