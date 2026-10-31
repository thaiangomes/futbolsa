import { compareReturns, returnBp, returnRate } from "./equity.js";
import type { Cents } from "./money.js";

/**
 * Ranking pelo retorno exato ([[Rankings mensal e anual]]). Retornos exatamente
 * iguais dividem a posição e o seguinte pula (1º, 2º, 2º, 4º). Sem desempate
 * por quem chegou antes ou por menos negócios.
 *
 * Quem aparece (bloqueados fora, bots pela chave do admin, conta excluída) é
 * decidido por quem chama: aqui entra a lista já filtrada.
 */

export interface RankInput {
  id: string;
  /** Patrimônio no instante da medida. */
  equity: Cents;
  /** Patrimônio de partida: R$ 100.000,00 na entrada, ou o do fechamento oficial anterior. */
  base: Cents;
}

export interface RankedRow extends RankInput {
  /** Posição, com empate dividindo (1, 2, 2, 4). */
  position: number;
  /** Retorno em pontos-base (800 = +8,00%), só para mostrar. */
  returnBp: number;
}

export function rank(rows: readonly RankInput[]): RankedRow[] {
  const withRate = rows.map((r, order) => ({ r, order, rate: returnRate(r.equity, r.base) }));
  // Do maior retorno para o menor; no empate, a ordem de entrada (ordenação estável).
  withRate.sort((a, b) => compareReturns(b.rate, a.rate) || a.order - b.order);

  const ranked: RankedRow[] = [];
  let position = 0;
  withRate.forEach((item, i) => {
    if (i === 0 || compareReturns(withRate[i - 1]!.rate, item.rate) !== 0) position = i + 1;
    ranked.push({ ...item.r, position, returnBp: returnBp(item.r.equity, item.r.base) });
  });
  return ranked;
}
