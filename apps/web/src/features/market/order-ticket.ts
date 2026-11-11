import { MARKET_ERROR_MESSAGES, type MarketErrorCode } from "@futbolsa/contracts";
import { validateOrder, type OrderState } from "@futbolsa/engine/engine/orderRules";
import { parseQuantity, parseReais } from "../ipo/forms";

/**
 * A boleta confere a ordem no navegador com o mesmo `validateOrder` do motor, antes de enviar (Livro de ofertas, "O que
 * é recusado"): o jogador vê o motivo na hora, com a mesma mensagem que a API daria. A API refaz tudo com a carteira
 * travada, então o que o navegador sabe a menos (caixa mudado há um segundo) a API corrige.
 */

export interface TicketForm {
  side: "buy" | "sell";
  type: "limit" | "market";
  /** O que o jogador digitou. */
  quantity: string;
  price: string;
}

/** O que a boleta sabe do clube e da carteira (do `GET /clubs/:ticker/book`, do `GET /orders` e do `me`). */
export interface TicketContext {
  displayedPrice: number;
  /** Caixa total (negativo só depois de um estorno). */
  cash: number;
  freeCash: number;
  freeShares: number;
  /** Ordens abertas em todos os clubes. */
  openOrders: number;
  /** As ordens abertas do jogador neste clube. */
  myOpenOrders: readonly { side: "buy" | "sell"; limitPrice: number }[];
  inAuction: boolean;
  /** O clube está em jogo agora: a revisão avisa. */
  inMatch: boolean;
}

export type TicketReview =
  | {
      ok: true;
      order: { side: "buy" | "sell"; type: "limit" | "market"; quantity: number; limitPrice?: number };
      /** Quanto vale a ordem pelo preço digitado (limitada). */
      total: number;
      /** Caixa preso: a compra limitada reserva quantidade × preço; a ordem a mercado não reserva caixa. */
      reserve: number;
      /** Ações presas: a venda (limitada ou a mercado) prende as ações. */
      reservedShares: number;
      inMatch: boolean;
    }
  | { ok: false; code: MarketErrorCode; message: string };

/** A mensagem de um código do contrato; código que a tela não conhece vira uma mensagem genérica. */
export function marketErrorMessage(code: string): string {
  return Object.hasOwn(MARKET_ERROR_MESSAGES, code)
    ? MARKET_ERROR_MESSAGES[code as MarketErrorCode]
    : "Não foi possível enviar a ordem. Tente de novo em instantes.";
}

export function reviewTicket(form: TicketForm, ctx: TicketContext): TicketReview {
  const refuse = (code: MarketErrorCode): TicketReview => ({ ok: false, code, message: marketErrorMessage(code) });

  const quantity = parseQuantity(form.quantity);
  if (quantity === null) return refuse("invalid_quantity");
  let limitPrice: number | undefined;
  if (form.type === "limit") {
    const parsed = parseReais(form.price);
    if (parsed === null || parsed <= 0) return refuse("invalid_price");
    limitPrice = parsed;
  }

  const state: OrderState = {
    displayedPrice: ctx.displayedPrice,
    cash: ctx.cash,
    availableCash: ctx.freeCash,
    availableShares: ctx.freeShares,
    openOrders: ctx.openOrders,
    myOpenOrders: ctx.myOpenOrders,
    inAuction: ctx.inAuction,
  };
  const verdict = validateOrder({ side: form.side, type: form.type, quantity, ...(limitPrice === undefined ? {} : { limitPrice }) }, state);
  if (!verdict.ok) return refuse(verdict.code);

  const total = limitPrice === undefined ? 0 : quantity * limitPrice;
  return {
    ok: true,
    order: { side: form.side, type: form.type, quantity, ...(limitPrice === undefined ? {} : { limitPrice }) },
    total,
    // compra limitada reserva quantidade × preço; compra a mercado não reserva (executa até o caixa livre)
    reserve: form.side === "buy" && form.type === "limit" ? total : 0,
    reservedShares: form.side === "sell" ? quantity : 0,
    inMatch: ctx.inMatch,
  };
}

/** Uma `Idempotency-Key` nova por envio: duas chamadas com a mesma chave nunca duplicam a ordem. */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
