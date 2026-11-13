import { createHash } from "node:crypto";
import { dayStart, isSuspiciousTrade, nextDayStart, type FraudTrade } from "@futbolsa/engine";
import type { FraudReport, FraudReportTrade } from "@futbolsa/contracts";

/**
 * A montagem pura do relatório de trapaça (T22): sem banco, só contas sobre o que o serviço leu. O serviço
 * (`report.service.ts`) lê os negócios, os preços com e sem, o valor justo e o patrimônio; aqui ficam a variação, os
 * pontos da série, os meses do período e o hash da foto.
 */

/** Um negócio do par como o serviço o lê da auditoria. */
export interface PairTrade {
  id: number;
  at: Date;
  clubId: number;
  ticker: string;
  quantity: number;
  price: number;
  priceBefore: number;
  inAuction: boolean;
  withHouse: boolean;
  annulled: boolean;
  buyerWalletId: number;
  sellerWalletId: number;
}

/** Variação sobre o preço anterior em pontos-base com sinal (700 = alta de 7%), arredondada para o mais perto. */
export function variationBp(price: number, before: number): number {
  if (before <= 0) return 0;
  const diff = price - before;
  const magnitude = Math.floor((Math.abs(diff) * 10_000 * 2 + before) / (before * 2));
  return diff < 0 ? -magnitude : magnitude;
}

/** O negócio como o motor do alerta o lê. */
export function toFraudTrade(t: PairTrade): FraudTrade {
  return {
    id: t.id,
    at: t.at.getTime(),
    clubId: t.clubId,
    buyerWallet: t.buyerWalletId,
    sellerWallet: t.sellerWalletId,
    quantity: t.quantity,
    price: t.price,
    priceBefore: t.priceBefore,
    withHouse: t.withHouse,
  };
}

/** Os negócios do relatório, do mais antigo para o mais novo, com o suspeito marcado pela regra do motor. */
export function reportTrades(trades: readonly PairTrade[], selected: ReadonlySet<number> = new Set()): FraudReportTrade[] {
  return [...trades]
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id)
    .map((t) => ({
      id: t.id,
      at: t.at.toISOString(),
      ticker: t.ticker,
      quantity: t.quantity,
      price: t.price,
      priceBefore: t.priceBefore,
      variationBp: variationBp(t.price, t.priceBefore),
      inAuction: t.inAuction,
      buyerWalletId: t.buyerWalletId,
      sellerWalletId: t.sellerWalletId,
      suspicious: isSuspiciousTrade(toFraudTrade(t)),
      selected: selected.has(t.id),
      annulled: t.annulled,
    }));
}

/** No máximo 60 pontos por série. */
export const MAX_SERIES_POINTS = 60;

/**
 * Os instantes da série de preço: o fim de cada dia (Brasília) do período, no máximo 60, espaçados se o período for
 * longo, mais o fim do período. Nunca passa de `to`.
 */
export function seriesInstants(from: number, to: number): number[] {
  const days: number[] = [];
  for (let d = nextDayStart(from) - 1; d < to; d = nextDayStart(d + 1) - 1) days.push(d);
  days.push(to);
  if (days.length <= MAX_SERIES_POINTS) return days;
  const step = (days.length - 1) / (MAX_SERIES_POINTS - 1);
  const picked: number[] = [];
  for (let i = 0; i < MAX_SERIES_POINTS; i++) picked.push(days[Math.round(i * step)]!);
  return [...new Set(picked)];
}

/** Os meses (`yyyy-mm`, de Brasília) que o período toca, do primeiro ao último. */
export function monthsOf(from: number, to: number, keyOf: (at: number) => string): string[] {
  const out: string[] = [];
  for (let d = dayStart(from); d <= to; d = nextDayStart(d)) {
    const key = keyOf(d);
    if (out[out.length - 1] !== key) out.push(key);
  }
  const last = keyOf(to);
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** A foto em JSON estável (chaves em ordem) e o hash dela: a prova de que não mudou depois da decisão. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

export function reportHash(report: FraudReport): string {
  return createHash("sha256").update(canonicalJson(report)).digest("hex");
}
