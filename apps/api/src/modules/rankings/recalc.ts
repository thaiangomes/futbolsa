import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../infra/db/transaction.js";
import { seasons } from "../../infra/db/schema/index.js";
import { EQUITY_BASE_CENTS } from "../portfolio/valuation/constants.js";
import { baseOf } from "./base.js";
import { buildRanking } from "./build-ranking.js";
import { measure, toStored } from "./close.js";
import { participantsByIds } from "./participants.js";
import { currentHeads, rowsOfSnapshot, writeSnapshot, type SnapshotHead, type StoredRow } from "./snapshots.js";

/**
 * Grava (ou acumula) o pedido de recálculo da temporada, **dentro da transação de quem chama** (P3): no máximo um pedido
 * aberto por temporada, com o menor `from` e os motivos juntos. Só escreve; não lê histórico nem trava carteira.
 */
export async function requestRecalc(tx: Tx, args: { seasonId: number; from: Date; reason: string; now?: Date }): Promise<void> {
  const now = (args.now ?? new Date()).toISOString();
  const from = args.from.toISOString();
  await tx.db.execute(sql`
    insert into futbolsa.ranking_recalc_requests (season_id, from_at, reason, requested_at)
    values (${args.seasonId}, ${from}::timestamptz, ${args.reason}, ${now}::timestamptz)
    on conflict (season_id) where done_at is null do update set
      from_at = least(futbolsa.ranking_recalc_requests.from_at, excluded.from_at),
      reason = case when position(excluded.reason in futbolsa.ranking_recalc_requests.reason) > 0
                    then futbolsa.ranking_recalc_requests.reason
                    else futbolsa.ranking_recalc_requests.reason || '; ' || excluded.reason end`);
}

/** Há pedido de recálculo aberto na temporada? (a F15 espera por ele antes de encerrar). */
export async function pendingRecalc(tx: Pick<Tx, "db">, seasonId: number): Promise<boolean> {
  const r = await tx.db.execute(sql`select 1 from futbolsa.ranking_recalc_requests where season_id = ${seasonId} and done_at is null limit 1`);
  return r.rows.length > 0;
}

function changed(before: readonly StoredRow[], after: readonly StoredRow[]): boolean {
  if (before.length !== after.length) return true;
  const old = new Map(before.map((r) => [r.walletId, r]));
  return after.some((r) => {
    const o = old.get(r.walletId);
    return !o || o.base !== r.base || o.equity !== r.equity || o.position !== r.position;
  });
}

/** Refaz um ranking já fechado, com o mesmo conjunto de carteiras e o patrimônio e a base de agora. Grava `version + 1` só se algo mudou. */
async function recalcOne(tx: Tx, seasonId: number, year: number, head: SnapshotHead, reason: string, now: Date): Promise<boolean> {
  const before = await rowsOfSnapshot(tx, head.id);
  const people = await participantsByIds(tx, before.map((r) => r.walletId));
  const measured = await measure(tx, seasonId, head.closedAt, people, async (list) =>
    head.period === "season" ? new Map(list.map((p) => [p.walletId, EQUITY_BASE_CENTS])) : baseOf(tx, seasonId, head.periodKey, list),
  );
  const after = toStored(buildRanking(measured));
  if (!changed(before, after)) return false;
  void year;
  return writeSnapshot(
    tx,
    { seasonId, period: head.period, periodKey: head.periodKey, closedAt: head.closedAt, botsIncluded: head.botsIncluded, version: head.version + 1, reason, createdAt: now },
    after,
  );
}

/**
 * Atende o pedido aberto de uma temporada (um por vez: `FOR UPDATE SKIP LOCKED`): temporada `closed` encerra o pedido sem
 * escrever; senão refaz, **do mais antigo para o mais novo**, todo ranking fechado com `closed_at ≥ from` (a base dos
 * meses seguintes muda, então a cascata sai na ordem). Devolve os rankings que ganharam versão nova, ou `null` se não havia pedido.
 */
export async function processOneRecalc(tx: Tx, now: Date): Promise<{ seasonId: number; versions: string[] } | null> {
  const picked = await tx.db.execute(sql`
    select id, season_id, from_at, reason from futbolsa.ranking_recalc_requests
    where done_at is null order by id limit 1 for update skip locked`);
  const req = picked.rows[0];
  if (!req) return null;
  const seasonId = Number(req.season_id);
  const from = new Date(req.from_at as string);
  const [season] = await tx.db.select().from(seasons).where(eq(seasons.id, seasonId));
  const versions: string[] = [];
  if (season && season.status !== "closed") {
    const heads = (await currentHeads(tx, seasonId)).filter((h) => h.closedAt.getTime() >= from.getTime());
    for (const head of heads) {
      if (await recalcOne(tx, seasonId, season.year, head, String(req.reason), now)) versions.push(`${head.period}:${head.periodKey}`);
    }
  }
  await tx.db.execute(sql`update futbolsa.ranking_recalc_requests set done_at = ${now.toISOString()}::timestamptz where id = ${Number(req.id)}`);
  return { seasonId, versions };
}
