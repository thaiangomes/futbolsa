import { assertCents, type Cents } from "./money.js";
import { mulDivRound } from "./rounding.js";

/**
 * Preço médio e custo de uma posição, como na B3 ([[Carteira e gráficos]]):
 * - compra soma `quantidade × preço` ao custo;
 * - venda tira custo na proporção das ações vendidas (arredondado ao centavo,
 *   meio centavo para cima) e a diferença entre o preço da venda e o preço
 *   médio vira resultado realizado; o preço médio não muda;
 * - zerar a posição zera o custo;
 * - dividendos ficam à parte e nunca mexem no custo; o total recebido no clube
 *   continua depois de zerar a posição.
 * O jogo não cobra taxas, então não há custo de corretagem.
 */

export interface CostPosition {
  /** Ações totais, inclusive as presas em ordens de venda. */
  shares: number;
  /** Custo da posição, em centavos. */
  cost: Cents;
  /** Resultado realizado acumulado na temporada, em centavos. */
  realized: Cents;
  /** Dividendos recebidos na temporada (estornos entram negativos), em centavos. */
  dividends: Cents;
}

export const emptyPosition = (): CostPosition => ({ shares: 0, cost: 0, realized: 0, dividends: 0 });

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Quantidade deve ser um inteiro positivo, recebido ${quantity}`);
  }
}

function assertPrice(price: Cents, label = "preço"): void {
  assertCents(price, label);
  if (price < 0) throw new Error(`O ${label} não pode ser negativo, recebido ${price}`);
}

/** Preço médio em centavos (custo ÷ ações, meio centavo para cima); zero sem ações. */
export function averagePrice(p: CostPosition): Cents {
  return p.shares === 0 ? 0 : mulDivRound(p.cost, 1, p.shares);
}

/** Compra (negócio, IPO ou carteira índice): soma `quantidade × preço` ao custo. */
export function buy(p: CostPosition, quantity: number, price: Cents): CostPosition {
  assertQuantity(quantity);
  assertPrice(price);
  if (price === 0) throw new Error("Preço de compra deve ser positivo");
  return { ...p, shares: p.shares + quantity, cost: p.cost + quantity * price };
}

/** Custo que sai quando `quantity` das `shares` ações saem da posição. */
function costRemoved(p: CostPosition, quantity: number): Cents {
  if (quantity > p.shares) {
    throw new Error(`Não há ${quantity} ações para tirar, a posição tem ${p.shares}`);
  }
  // A saída total leva o custo inteiro, sem sobra de centavo.
  return quantity === p.shares ? p.cost : mulDivRound(p.cost, quantity, p.shares);
}

/** Venda (negócio ou recompra): tira custo na proporção e realiza a diferença. */
export function sell(
  p: CostPosition,
  quantity: number,
  price: Cents,
): { position: CostPosition; realized: Cents } {
  assertQuantity(quantity);
  assertPrice(price);
  const removed = costRemoved(p, quantity);
  const realized = quantity * price - removed;
  return {
    position: {
      ...p,
      shares: p.shares - quantity,
      cost: p.cost - removed,
      realized: p.realized + realized,
    },
    realized,
  };
}

/** Ações creditadas pelo admin: entram pelo preço exibido no momento do crédito. */
export function creditShares(p: CostPosition, quantity: number, displayedPrice: Cents): CostPosition {
  return buy(p, quantity, displayedPrice);
}

/** Ações debitadas pelo admin: tiram custo na proporção, sem resultado realizado. */
export function debitShares(p: CostPosition, quantity: number): CostPosition {
  assertQuantity(quantity);
  const removed = costRemoved(p, quantity);
  return { ...p, shares: p.shares - quantity, cost: p.cost - removed };
}

/** Dividendo recebido (ou estornado, se negativo): só soma no total do clube. */
export function addDividend(p: CostPosition, amount: Cents): CostPosition {
  assertCents(amount, "dividendo");
  return { ...p, dividends: p.dividends + amount };
}

export interface PositionSummary {
  /** Ações totais × preço exibido. */
  marketValue: Cents;
  /** Valor a mercado − custo. */
  unrealized: Cents;
  /** Não realizado sobre o custo, em décimos de ponto percentual (189 = 18,9%); zero sem custo. */
  unrealizedPermille: number;
  /** Realizado + não realizado + dividendos recebidos + a receber. */
  total: Cents;
}

/**
 * Resumo da posição a um preço. O preço vem de quem chama: o último negócio e,
 * antes do primeiro, o preço do IPO. `receivable` é o dividendo de evento já
 * fechado e ainda não aprovado.
 */
export function summarize(p: CostPosition, price: Cents, receivable: Cents = 0): PositionSummary {
  assertPrice(price);
  assertCents(receivable, "a receber");
  const marketValue = p.shares * price;
  const unrealized = marketValue - p.cost;
  const permille =
    p.cost === 0 ? 0 : Math.sign(unrealized) * mulDivRound(Math.abs(unrealized), 1_000, p.cost);
  return {
    marketValue,
    unrealized,
    unrealizedPermille: permille,
    total: p.realized + unrealized + p.dividends + receivable,
  };
}
