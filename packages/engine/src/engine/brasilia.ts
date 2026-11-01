/**
 * Dias e meses do jogo contados no fuso de Brasília ([[Arquitetura da Fase 1]]).
 *
 * O fuso é fixo em UTC−3: o Brasil não tem horário de verão desde 2019, e o
 * motor só trabalha com datas desde então. Se o horário de verão voltar, esta
 * é a única função a trocar (por uma tabela de fuso), e os testes mostram onde.
 * Instantes são milissegundos desde 1970 (UTC), sempre recebidos por parâmetro.
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Brasília está 3 horas atrás de UTC. */
export const BRASILIA_OFFSET_MS = -3 * HOUR_MS;

function assertInstant(at: number): void {
  if (!Number.isFinite(at)) throw new Error(`Instante inválido: ${at}`);
}

/** Relógio de parede de Brasília como se fosse UTC (para usar `Date.UTC` e `getUTC*`). */
const toLocal = (at: number) => at + BRASILIA_OFFSET_MS;
const fromLocal = (local: number) => local - BRASILIA_OFFSET_MS;

/** 0h de Brasília do dia que contém `at`. */
export function dayStart(at: number): number {
  assertInstant(at);
  return fromLocal(Math.floor(toLocal(at) / DAY_MS) * DAY_MS);
}

/** 0h de Brasília do dia seguinte ao que contém `at`. */
export function nextDayStart(at: number): number {
  return dayStart(at) + DAY_MS;
}

/** `hour`h de Brasília do dia seguinte ao que contém `at` (a negociação abre às 10h). */
export function nextDayAt(at: number, hour: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`Hora inválida: ${hour}`);
  return nextDayStart(at) + hour * HOUR_MS;
}

/**
 * Fechamento do mês: 23:59:00,000 de Brasília do último dia (decisão do Thaian em
 * 2026-10-31). O negócio nesse instante ainda conta no mês; o seguinte, não.
 * `month` vai de 1 a 12.
 */
export function monthCloseAt(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Mês inválido: ${year}-${month}`);
  }
  // 0h do dia 1 do mês seguinte (relógio de Brasília), menos um minuto.
  return fromLocal(Date.UTC(year, month, 1) - MINUTE_MS);
}

/** Chave do mês de Brasília que contém `at`, como "2027-06". */
export function monthKey(at: number): string {
  assertInstant(at);
  const d = new Date(toLocal(at));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
