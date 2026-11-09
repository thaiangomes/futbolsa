import { selfTradeConflict } from "./matching.js";
import { assertCents, MIN_PRICE, type Cents } from "./money.js";
import type { OrderType, Side } from "./orderbook.js";

/**
 * Recusas de uma ordem que não dependem do casamento (especificação "Livro de
 * ofertas e formador de mercado", seção "O que é recusado"). Horário,
 * suspensão, bloqueio e e-mail não confirmado dependem do banco e do relógio e
 * ficam na API. Os códigos são os do contrato de `POST /orders`.
 */

export type RejectCode =
  | "invalid_quantity"
  | "invalid_price"
  | "below_min_price"
  | "negative_cash"
  | "price_out_of_band"
  | "too_many_open_orders"
  | "insufficient_cash"
  | "insufficient_shares"
  | "self_trade"
  | "club_in_auction";

/** Máximo de ordens abertas por jogador ou bot, somando todos os clubes. */
export const MAX_OPEN_ORDERS = 50;

export interface TradingBand {
  min: Cents;
  max: Cents;
}

/**
 * Faixa de preço aceita para ordens novas: 20% em volta do preço exibido (o
 * último negócio; antes dele, o preço do IPO), arredondada para dentro, nunca
 * abaixo de R$ 0,50. Não vale para a casa nem para as ordens que já estão no livro.
 */
export function tradingBand(displayedPrice: Cents): TradingBand {
  assertCents(displayedPrice, "preço exibido");
  return {
    min: Math.max(MIN_PRICE, Math.ceil((displayedPrice * 4) / 5)),
    max: Math.floor((displayedPrice * 6) / 5),
  };
}

export interface OrderRequestShape {
  side: Side;
  type: OrderType;
  quantity: number;
  limitPrice?: Cents;
}

/** O que quem chama sabe da conta e do clube no envio (na API, lido com a carteira travada). */
export interface OrderState {
  displayedPrice: Cents;
  /** Caixa total: negativo só depois de um estorno. */
  cash: Cents;
  availableCash: Cents;
  /** Ações livres do clube. */
  availableShares: number;
  /** Ordens abertas da conta em todos os clubes. */
  openOrders: number;
  /** Ordens abertas da conta neste clube (a regra olha só as do lado oposto). */
  myOpenOrders: readonly { side: Side; limitPrice: Cents }[];
  /** A casa não passa pela faixa de 20% nem pelo limite de 50 ordens. */
  isHouse?: boolean;
  /** O clube está em leilão: ordem a mercado é recusada (`club_in_auction`) e a limitada entra no livro sem casar. */
  inAuction?: boolean;
  /**
   * O túnel de preço do clube (`tunnelBand` da referência), fora de leilão. O teto da compra a mercado e o piso
   * da venda a mercado passam a ser o mais apertado entre os 20% e o túnel: a ordem a mercado executa só dentro
   * do túnel e o resto é cancelado, sem abrir leilão (D1). Não muda a ordem limitada, que pode sair do túnel e
   * abrir o leilão.
   */
  tunnel?: TradingBand;
}

export type OrderValidation = { ok: true; marketPriceLimit?: Cents } | { ok: false; code: RejectCode };

/**
 * Confere a ordem na ordem: formato → caixa negativo → faixa de 20% → 50
 * ordens abertas → caixa ou ações livres → ordem contra si mesmo. A ordem a
 * mercado aprovada volta com o limite de preço do casamento (teto na compra,
 * piso na venda), para a faixa ser calculada num lugar só.
 */
export function validateOrder(req: OrderRequestShape, state: OrderState): OrderValidation {
  const reject = (code: RejectCode): OrderValidation => ({ ok: false, code });

  if (!Number.isSafeInteger(req.quantity) || req.quantity <= 0) return reject("invalid_quantity");
  if (req.type === "limit") {
    if (req.limitPrice === undefined || !Number.isSafeInteger(req.limitPrice) || req.limitPrice <= 0) return reject("invalid_price");
    if (req.limitPrice < MIN_PRICE) return reject("below_min_price");
    if (!Number.isSafeInteger(req.quantity * req.limitPrice)) return reject("invalid_quantity");
  }

  // Em leilão não sai negócio, e a ordem a mercado não tem preço para esperar o preço único.
  if (state.inAuction && req.type === "market") return reject("club_in_auction");

  if (req.side === "buy" && state.cash < 0) return reject("negative_cash");

  const band = state.isHouse ? undefined : tradingBand(state.displayedPrice);
  if (band && req.type === "limit" && (req.limitPrice! < band.min || req.limitPrice! > band.max)) return reject("price_out_of_band");

  // A ordem a mercado nunca fica aberta, então não conta para o limite.
  if (!state.isHouse && req.type === "limit" && state.openOrders >= MAX_OPEN_ORDERS) return reject("too_many_open_orders");

  if (req.side === "buy" && req.type === "limit" && req.quantity * req.limitPrice! > state.availableCash) return reject("insufficient_cash");
  if (req.side === "sell" && req.quantity > state.availableShares) return reject("insufficient_shares");

  if (selfTradeConflict(req, state.myOpenOrders)) return reject("self_trade");

  if (req.type === "market" && band) {
    const ceiling = state.tunnel ? Math.min(band.max, state.tunnel.max) : band.max;
    const floor = state.tunnel ? Math.max(band.min, state.tunnel.min) : band.min;
    return { ok: true, marketPriceLimit: req.side === "buy" ? ceiling : floor };
  }
  return { ok: true };
}
