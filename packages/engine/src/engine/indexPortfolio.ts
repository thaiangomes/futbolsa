import { assertCents, MIN_PRICE, reais, type Cents } from "./money.js";

/**
 * Carteira índice da entrada no meio da temporada: a mesma quantidade N de
 * ações de cada clube listado, valendo até R$ 70.000 a preços atuais, mais o
 * resto em caixa, de modo que a conta começa com exatamente R$ 100.000,00.
 *
 * O preço de cada clube é o de referência (último negócio no momento da
 * confirmação; sem negócio, o do IPO), que quem chama decide. Aqui só a conta.
 */

export const ENTRY_TOTAL: Cents = reais(100_000);
export const ENTRY_STOCK_BUDGET: Cents = reais(70_000);

export interface IndexPortfolio {
  /** Ações de cada clube (zero se a soma dos preços passa do orçamento). */
  n: number;
  /** Soma dos preços de referência de todos os clubes listados. */
  sum: Cents;
  /** Caixa da conta: total − N × soma. */
  cash: Cents;
  /** N × soma dos preços. */
  stockValue: Cents;
  /** Uma linha por clube, com o preço de referência como custo por ação. */
  clubs: { clubId: string; shares: number; costPerShare: Cents }[];
}

export function indexPortfolio(
  prices: Readonly<Record<string, Cents>>,
  { stockBudget = ENTRY_STOCK_BUDGET, total = ENTRY_TOTAL }: { stockBudget?: Cents; total?: Cents } = {},
): IndexPortfolio {
  const entries = Object.entries(prices);
  if (entries.length === 0) throw new Error("A carteira índice precisa de pelo menos um clube");
  let sum = 0;
  for (const [clubId, price] of entries) {
    assertCents(price, `preço de ${clubId}`);
    if (price < MIN_PRICE) throw new Error(`Preço de ${clubId} abaixo do piso de R$ 0,50: ${price}`);
    sum += price;
  }
  const n = Math.floor(stockBudget / sum);
  return {
    n,
    sum,
    cash: total - n * sum,
    stockValue: n * sum,
    clubs: entries.map(([clubId, price]) => ({ clubId, shares: n, costPerShare: price })),
  };
}
