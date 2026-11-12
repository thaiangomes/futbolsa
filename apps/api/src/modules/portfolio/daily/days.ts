import { BRASILIA_OFFSET_MS, dayStart, nextDayStart } from "@futbolsa/engine";

/** O dia de Brasília (`2027-04-06`) que contém o instante. */
export function brasiliaDay(at: number): string {
  return new Date(at + BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
}

/** O instante do ponto de cada dia: as 24h de Brasília do dia D, um milissegundo antes da virada (a virada já é o dia seguinte). */
export function dayPointAt(dayStartMs: number): number {
  return nextDayStart(dayStartMs) - 1;
}

/** Folga depois do instante de fechamento, para as transações em andamento terminarem (P6). */
export const CLOSE_GRACE_MS = 30_000;

/** Os dias de Brasília já fechados (com a folga) entre o dia de `from` e `now`, do mais antigo para o mais novo. */
export function closedDays(from: number, now: number): number[] {
  const days: number[] = [];
  for (let start = dayStart(from); nextDayStart(start) + CLOSE_GRACE_MS <= now; start = nextDayStart(start)) days.push(start);
  return days;
}
