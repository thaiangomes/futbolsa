import { assertCents, type Cents } from "./money.js";
import { mulDivRound } from "./rounding.js";

/**
 * Patrimônio e retorno ([[Rankings mensal e anual]]).
 *
 * Patrimônio = caixa total (pode ser negativo depois de um estorno; a reserva de
 * ordens já está nele) + ações × preço exibido + dividendos e recompra a receber.
 * Depois que a recompra fecha, as ações de todos os clubes valem R$ 0,00 e conta
 * só a recompra a receber, para ela não contar duas vezes.
 *
 * Reconstruir caixa e ações num instante a partir do extrato é de quem chama
 * (módulo `rankings`); aqui entram os números prontos.
 */

export interface EquityInput {
  /** Caixa total, inclusive o reservado. */
  cash: Cents;
  /** Ações totais por clube (inclusive as presas em ordens de venda) e o preço exibido no instante. */
  positions: readonly { shares: number; price: Cents }[];
  /** Dividendos e recompra a receber (eventos fechados, ainda não creditados). */
  receivable?: Cents;
  /** A recompra já fechou: as ações valem R$ 0,00. */
  buybackClosed?: boolean;
}

export function equity({ cash, positions, receivable: due = 0, buybackClosed = false }: EquityInput): Cents {
  assertCents(cash, "caixa");
  assertCents(due, "a receber");
  let stocks = 0;
  if (!buybackClosed) {
    for (const p of positions) {
      assertCents(p.price, "preço");
      stocks += p.shares * p.price;
    }
  }
  return cash + stocks + due;
}

export interface PayoutDue {
  /** Instante em que o evento fechou (define quem recebe). */
  closedAt: number;
  /** Valor por ação do evento, na versão atual (já corrigida). */
  perShare: Cents;
  /** Ações da carteira na foto do fechamento. */
  shares: number;
  /** O que desse evento já tinha caído no caixa até o instante pedido. */
  credited: Cents;
}

/**
 * Dividendo e recompra a receber no instante `at`: para cada evento fechado até
 * ele, `ações no fechamento × valor por ação − o que já caiu no caixa`. Passa do
 * "a receber" para o caixa quando o crédito cai, sem contar duas vezes.
 */
export function receivable(at: number, events: readonly PayoutDue[]): Cents {
  let total = 0;
  for (const e of events) {
    if (e.closedAt > at) continue;
    total += e.shares * e.perShare - e.credited;
  }
  return total;
}

/** Retorno como fração exata, (patrimônio − base) ÷ base, para comparar sem erro de arredondamento. */
export interface ReturnRate {
  numerator: bigint;
  /** Sempre positivo. */
  denominator: bigint;
}

export function returnRate(equityNow: Cents, base: Cents): ReturnRate {
  assertCents(equityNow, "patrimônio");
  assertCents(base, "base");
  if (base <= 0) throw new Error(`A base do retorno deve ser positiva, recebida ${base}`);
  return { numerator: BigInt(equityNow - base), denominator: BigInt(base) };
}

/** Compara dois retornos exatos: negativo se a < b, zero se iguais, positivo se a > b. */
export function compareReturns(a: ReturnRate, b: ReturnRate): number {
  const left = a.numerator * b.denominator;
  const right = b.numerator * a.denominator;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Retorno em pontos-base (800 = +8,00%), meio ponto-base para longe do zero. Só
 * para mostrar: a ordem do ranking usa o retorno exato.
 */
export function returnBp(equityNow: Cents, base: Cents): number {
  assertCents(equityNow, "patrimônio");
  assertCents(base, "base");
  if (base <= 0) throw new Error(`A base do retorno deve ser positiva, recebida ${base}`);
  const gain = equityNow - base;
  return Math.sign(gain) * mulDivRound(Math.abs(gain), 10_000, base);
}
