import { eq } from "drizzle-orm";
import { monthKey } from "@futbolsa/engine";
import type { Tx } from "../../infra/db/transaction.js";
import { seasons } from "../../infra/db/schema/index.js";
import { EQUITY_BASE_CENTS } from "../portfolio/valuation/constants.js";
import { baseOf, closeAtOfMonth, nextMonthKey } from "./base.js";
import { buildRanking, type Measured } from "./build-ranking.js";
import { equityAtWallets } from "./equity-at.js";
import { participants, type Participant } from "./participants.js";
import { currentSnapshot, writeSnapshot, type Period, type StoredRow } from "./snapshots.js";

/** A folga da tarefa: a mesma do ponto diário e da foto mensal da carteira (F10), para uma transação que começou antes das 23h59 entrar no extrato antes da leitura. */
export { CLOSE_GRACE_MS } from "../portfolio/daily/days.js";

async function seasonOf(tx: Tx, seasonId: number) {
  const [season] = await tx.db.select().from(seasons).where(eq(seasons.id, seasonId));
  if (!season) throw new Error(`temporada ${seasonId} não existe`);
  return season;
}

/** Mede quem aparece em `at`: o patrimônio de cada um e a base dada por `baseFor`. */
export async function measure(
  tx: Tx,
  seasonId: number,
  at: Date,
  people: readonly Participant[],
  baseFor: (people: readonly Participant[]) => Promise<Map<number, number>>,
): Promise<Measured[]> {
  const equities = await equityAtWallets(tx, seasonId, at, people.map((p) => p.walletId));
  const bases = await baseFor(people);
  const out: Measured[] = [];
  for (const p of people) {
    const e = equities.get(p.walletId);
    const base = bases.get(p.walletId);
    if (e && base !== undefined) out.push({ walletId: p.walletId, equity: e.equity, base });
  }
  return out;
}

export const toStored = (rows: ReturnType<typeof buildRanking>): StoredRow[] => rows.map((r) => ({ walletId: r.walletId, base: r.base, equity: r.equity, position: r.position }));

/**
 * Fecha o ranking oficial de um mês em `at` (T5): patrimônio de cada um em `at`, base do mês anterior, versão 1 em
 * `ranking_snapshots` e `ranking_rows`, com a chave "bots nos rankings" **deste instante**. Idempotente: se o mês já
 * tem oficial (ou outra transação o grava ao mesmo tempo), não grava de novo e devolve `false`. Roda no `tx` de quem
 * chama e não trava carteira, clube nem temporada.
 */
export async function closeMonth(tx: Tx, args: { seasonId: number; monthKey: string; at: Date; now?: Date }): Promise<boolean> {
  const { seasonId, at } = args;
  if (await currentSnapshot(tx, seasonId, "month", args.monthKey)) return false;
  const season = await seasonOf(tx, seasonId);
  const people = await participants(tx, seasonId, at, { botsIncluded: season.botsInRankings });
  const measured = await measure(tx, seasonId, at, people, (list) => baseOf(tx, seasonId, args.monthKey, list));
  return writeSnapshot(
    tx,
    { seasonId, period: "month", periodKey: args.monthKey, closedAt: at, botsIncluded: season.botsInRankings, version: 1, reason: null, createdAt: args.now ?? at },
    toStored(buildRanking(measured)),
  );
}

/**
 * Fecha o ano em `at` (base R$ 100.000,00 para todos) e, se o mês de `at` ainda não tem oficial, também esse mês no
 * mesmo instante. Quem chama (a F15, com a temporada travada) passa o instante dela, sem folga.
 */
export async function closeSeason(tx: Tx, args: { seasonId: number; at: Date; now?: Date }): Promise<{ month: boolean; season: boolean }> {
  const { seasonId, at } = args;
  const season = await seasonOf(tx, seasonId);
  const key = String(season.year);
  const month = await closeMonth(tx, { seasonId, monthKey: monthKey(at.getTime()), at, now: args.now });
  if (await currentSnapshot(tx, seasonId, "season", key)) return { month, season: false };
  const people = await participants(tx, seasonId, at, { botsIncluded: season.botsInRankings });
  const measured = await measure(tx, seasonId, at, people, async (list) => new Map(list.map((p) => [p.walletId, EQUITY_BASE_CENTS])));
  const written = await writeSnapshot(
    tx,
    { seasonId, period: "season", periodKey: key, closedAt: at, botsIncluded: season.botsInRankings, version: 1, reason: null, createdAt: args.now ?? at },
    toStored(buildRanking(measured)),
  );
  return { month, season: written };
}

/**
 * Os meses cujo fechamento já passou (com a folga), do primeiro mês da temporada até o último fechado. O limite é o
 * encerramento da temporada (`closed_at`), não o fim da negociação: o mês do apito final é um mês civil comum e fecha
 * às 23h59 do último dia se a temporada ainda não foi encerrada; só o mês do encerramento (e os seguintes) são do
 * `closeSeason`, que mede no instante do encerramento.
 */
export function monthsDue(season: { ipoOpensAt: Date | null; closedAt: Date | null }, until: Date): string[] {
  if (!season.ipoOpensAt) return [];
  const limit = season.closedAt !== null ? Math.min(until.getTime(), season.closedAt.getTime()) : until.getTime();
  const out: string[] = [];
  for (let key = monthKey(season.ipoOpensAt.getTime()); closeAtOfMonth(key).getTime() <= limit; key = nextMonthKey(key)) {
    out.push(key);
    if (out.length > 240) break;
  }
  return out;
}

export type { Period };
