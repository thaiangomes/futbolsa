import type { EquityResponse } from "@futbolsa/contracts";
import { formatMoney } from "../format";

export interface EquityPoint {
  /** Segundos desde 1970 (o tempo das séries). */
  time: number;
  /** Reais (a escala do gráfico). */
  value: number;
}

export interface EquityMarker {
  time: number;
  text: string;
  /** O total de dividendos creditados no dia, em centavos. */
  total: number;
}

export interface EquitySeries {
  points: EquityPoint[];
  markers: EquityMarker[];
  /** A linha de referência: R$ 100.000,00. */
  base: number;
}

/** 24h de Brasília do dia `2027-04-06`, em segundos: `2027-04-06T23:59:00-03:00`. */
function dayEnd(day: string): number {
  return Math.floor(Date.parse(`${day}T23:59:00-03:00`) / 1000);
}

/** O dia de Brasília de um instante ISO. */
function brasiliaDayOf(iso: string): string {
  return new Date(Date.parse(iso) - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * O gráfico de patrimônio: parte do ponto de entrada (R$ 100.000,00), um ponto por dia fechado e o valor atual no fim, com
 * a linha de R$ 100.000,00 e um marcador nos dias com dividendo (total do dia). O dia de hoje, ainda aberto, fica no ponto
 * atual. Pontos fora de ordem ou duplicados no mesmo segundo são descartados (a biblioteca exige tempo crescente).
 */
export function equitySeries(data: EquityResponse): EquitySeries {
  const start = Math.floor(Date.parse(data.startedAt) / 1000);
  const current = Math.floor(Date.parse(data.current.at) / 1000);
  const raw: EquityPoint[] = [{ time: start, value: data.base / 100 }];
  const dayTimes = new Map<string, number>();
  for (const p of data.points) {
    const time = dayEnd(p.day);
    dayTimes.set(p.day, time);
    raw.push({ time, value: p.equity / 100 });
  }
  raw.push({ time: current, value: data.current.equity / 100 });
  const points: EquityPoint[] = [];
  for (const p of raw.sort((a, b) => a.time - b.time)) {
    if (points.length > 0 && points[points.length - 1]!.time >= p.time) continue;
    points.push(p);
  }
  const today = brasiliaDayOf(data.current.at);
  const markers: EquityMarker[] = [];
  for (const d of data.dividendDays) {
    const time = dayTimes.get(d.day) ?? (d.day === today ? current : null);
    if (time === null || !points.some((p) => p.time === time)) continue;
    markers.push({ time, total: d.total, text: formatMoney(d.total) });
  }
  return { points, markers, base: data.base / 100 };
}
