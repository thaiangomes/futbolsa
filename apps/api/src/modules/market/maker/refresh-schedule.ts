import { dayStart } from "@futbolsa/engine";

/**
 * A agenda da reposição da casa (Livro de ofertas, "Reposição"): a casa cancela as cotações e coloca novas a cada 3
 * horas de Brasília (0h, 3h, 6h... 21h), na estreia, quando um jogo do clube começa e, por pedido, quando um placar
 * entra ou é corrigido, uma rodada ou fase fecha ou uma suspensão termina. Aqui só a conta por horário; os pedidos
 * ficam em `market_refresh_requests`.
 *
 * "Nunca antes da hora": o que foi executado entre duas reposições não volta antes da seguinte, nem com a API
 * reiniciando. Por isso a agenda é **calculada** (a última reposição devida) e comparada com `mm_refreshed_at`, em
 * vez de uma fila de horários: com a API fora de 9h às 13h, ao voltar ela repõe uma vez, e não três.
 */

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

export interface DueInput {
  now: Date;
  /** `trading_opens_at`: a primeira cotação é devida nele. Vazio ou no futuro: nada é devido ainda. */
  opensAt: Date | null;
  /**
   * Os inícios dos jogos do clube que valem para o modo de jogo (os adiados e cancelados já ficam de fora de quem
   * chama). Só os que já começaram contam.
   */
  kickoffs: readonly Date[];
}

/** O último horário de 3 em 3 horas de Brasília que já passou (inclusive o instante exato). */
function lastThreeHourMark(now: number): number {
  const start = dayStart(now);
  return start + Math.floor((now - start) / THREE_HOURS_MS) * THREE_HOURS_MS;
}

/**
 * A última reposição devida: o maior entre o último horário de 3 em 3 horas, a abertura da negociação e o início do
 * último jogo do clube que já começou. `null` antes da abertura.
 */
export function lastDueRefresh({ now, opensAt, kickoffs }: DueInput): Date | null {
  if (opensAt === null || now.getTime() < opensAt.getTime()) return null;
  let due = Math.max(opensAt.getTime(), lastThreeHourMark(now.getTime()));
  for (const kickoff of kickoffs) {
    if (kickoff.getTime() <= now.getTime()) due = Math.max(due, kickoff.getTime());
  }
  return new Date(due);
}

/**
 * Se o clube precisa de reposição: a última devida é posterior à última feita (ou nunca houve), ou há um pedido
 * aberto. Sem horário devido (a negociação não abriu) nem um pedido repõe.
 */
export function needsRefresh(s: { refreshedAt: Date | null; due: Date | null; pendingRequest: boolean }): boolean {
  if (s.due === null) return false;
  if (s.pendingRequest) return true;
  return s.refreshedAt === null || s.refreshedAt.getTime() < s.due.getTime();
}
