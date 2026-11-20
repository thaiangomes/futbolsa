import type { Cents } from "./money.js";
import type { PayoutEvent } from "./payoutEvents.js";
import { mulDivRound } from "./rounding.js";

/**
 * Recompra no fim da temporada ([[Dividendos e recompra]]): 1,5 vez o total que a
 * ação pagou na temporada (pontos, colocação, acesso e copas, já com estornos e
 * complementos), arredondado ao centavo com meio centavo para cima, num instante
 * único para todos os clubes: o fechamento do último evento da temporada.
 */

/** Valor da recompra por ação. `multipleBp` em pontos-base (15.000 = 1,5×). */
export function buybackPerShare(totalPaid: Cents, multipleBp: number): Cents {
  if (!Number.isInteger(multipleBp) || multipleBp < 0) {
    throw new Error(`O múltiplo da recompra deve ser um inteiro não negativo em pontos-base, recebido ${multipleBp}`);
  }
  return mulDivRound(totalPaid, multipleBp, 10_000);
}

/**
 * Instante em que a recompra fecha: o maior dos fechamentos das competições da
 * temporada (`closes` de `eventsFor`). Enquanto alguma ainda está aberta
 * (`undefined`), ou não há competição, não há instante.
 */
export function buybackCloseTime(closes: Readonly<Record<string, number | undefined>>): number | undefined {
  const values = Object.values(closes);
  if (values.length === 0 || values.some((v) => v === undefined)) return undefined;
  return Math.max(...(values as number[]));
}

/**
 * Um evento de recompra por clube listado, inclusive R$ 0,00 para o que não pagou
 * nada, todos em `closedAt`. `events` são os eventos na versão atual (já corrigidos);
 * eventos de recompra anteriores são ignorados na soma.
 */
export function buybackEvents(
  events: readonly PayoutEvent[],
  listed: ReadonlySet<string>,
  multipleBp: number,
  closedAt: number,
): PayoutEvent[] {
  const totals = new Map<string, Cents>([...listed].map((clubId) => [clubId, 0]));
  for (const e of events) {
    // A recompra não entra na própria base, e a penalização de rebaixamento fica fora dela.
    if (e.kind === "buyback" || e.kind === "relegation") continue;
    if (e.closedAt > closedAt) {
      throw new Error(`O evento ${e.key} fecha depois do instante da recompra`);
    }
    if (totals.has(e.clubId)) totals.set(e.clubId, totals.get(e.clubId)! + e.perShare);
  }
  const multiple = (multipleBp / 10_000).toString().replace(".", ",");
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([clubId, total]) => ({
      key: `buyback|temporada|fim|${clubId}`,
      kind: "buyback" as const,
      clubId,
      competition: "temporada",
      stage: "fim",
      perShare: buybackPerShare(total, multipleBp),
      closedAt,
      reason: `recompra: ${multiple}× os dividendos da temporada`,
    }));
}
