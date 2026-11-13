import { monthCloseAt, type Cents } from "@futbolsa/engine";
import type { Tx } from "../../infra/db/transaction.js";
import { EQUITY_BASE_CENTS } from "../portfolio/valuation/constants.js";
import { equityAtWallets } from "./equity-at.js";
import type { Participant } from "./participants.js";
import { currentRowsOf } from "./snapshots.js";

/** O mês anterior de `yyyy-mm`. */
export function previousMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** O mês seguinte de `yyyy-mm`. */
export function nextMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** O instante do fechamento oficial do mês `yyyy-mm` (23:59 de Brasília do último dia). */
export function closeAtOfMonth(key: string): Date {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return new Date(monthCloseAt(y, m));
}

/**
 * A base de cada participante num mês (P2 e T4): R$ 100.000,00 para quem entrou depois do fechamento do mês anterior
 * (no primeiro mês da temporada ninguém entrou antes); para os outros, o patrimônio da linha da **versão atual** do
 * ranking oficial do mês anterior, completado pelo histórico (`equityAtWallets` no fechamento anterior) para quem não
 * está lá (bloqueado naquele fechamento e desbloqueado depois, bot que entrou na chave depois). O valor pode ser ≤ 0:
 * quem chama trata como "sem base". O ranking do ano usa sempre R$ 100.000,00 e não passa por aqui.
 */
export async function baseOf(tx: Tx, seasonId: number, month: string, people: readonly Participant[]): Promise<Map<number, Cents>> {
  const prevKey = previousMonthKey(month);
  const prevClose = closeAtOfMonth(prevKey);
  const out = new Map<number, Cents>();
  const returning: Participant[] = [];
  for (const p of people) {
    if (p.enteredAt.getTime() > prevClose.getTime()) out.set(p.walletId, EQUITY_BASE_CENTS);
    else returning.push(p);
  }
  if (returning.length === 0) return out;
  const official = await currentRowsOf(tx, seasonId, "month", prevKey);
  const missing: number[] = [];
  for (const p of returning) {
    const row = official?.get(p.walletId);
    if (row) out.set(p.walletId, row.equity);
    else missing.push(p.walletId);
  }
  if (missing.length > 0) {
    const computed = await equityAtWallets(tx, seasonId, prevClose, missing);
    for (const id of missing) out.set(id, computed.get(id)?.equity ?? EQUITY_BASE_CENTS);
  }
  return out;
}
