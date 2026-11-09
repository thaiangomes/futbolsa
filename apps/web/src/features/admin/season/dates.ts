const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Brasília está 3 horas atrás de UTC (sem horário de verão desde 2019), como no motor (`brasilia.ts`). */
const BRASILIA_OFFSET_MS = -3 * HOUR_MS;
/** Hora de Brasília em que a negociação abre, no dia seguinte ao fechamento do IPO (`TRADING_OPENS_HOUR` do motor). */
const TRADING_OPENS_HOUR = 10;

/**
 * O valor de um campo `datetime-local` (`2027-04-06T16:00`, hora de Brasília) em ISO com fuso
 * (`2027-04-06T19:00:00.000Z`), que é o que o `PATCH /admin/seasons/:id` espera. Data inexistente é `null`.
 */
export function brasiliaInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day || local.getUTCHours() !== hour) return null;
  return new Date(local.getTime() - BRASILIA_OFFSET_MS).toISOString();
}

/**
 * Quando a negociação abre depois de um fechamento: 10h de Brasília do dia seguinte. É a conta de
 * `postponeClose` do motor (`@futbolsa/engine`), que o site não importa; o teste confere as duas.
 */
export function tradingOpensAfter(closesAtIso: string): string {
  const local = Date.parse(closesAtIso) + BRASILIA_OFFSET_MS;
  const nextDayLocal = Math.floor(local / DAY_MS) * DAY_MS + DAY_MS + TRADING_OPENS_HOUR * HOUR_MS;
  return new Date(nextDayLocal - BRASILIA_OFFSET_MS).toISOString();
}
