import { type SQL, sql } from "drizzle-orm";
import type { Cents } from "@futbolsa/engine";
import type { Tx } from "../../../../infra/db/transaction.js";

/** Quais carteiras entram: as da lista, ou todas as de jogadores e bots da temporada (nunca a tesouraria). */
export function walletFilter(seasonId: number, walletIds: readonly number[] | undefined, alias: string): SQL {
  const a = sql.raw(alias);
  if (walletIds === undefined) return sql`${a}.season_id = ${seasonId} and ${a}.owner_type <> 'treasury'`;
  if (walletIds.length === 0) return sql`false`;
  return sql`${a}.id in (${sql.join(walletIds.map((id) => sql`${id}`), sql`, `)})`;
}

/**
 * O que sai da conta de `at` além dos movimentos depois dele (F14, T21 da F10):
 * - a linha `trade_annulled` conta pelo horário do **negócio original** (`ref`), não pelo dia da anulação (P11 do Plano dos
 *   rankings): assim o ranking de julho sai sem os negócios anulados em agosto;
 * - `ignoreTrades` são negócios ainda não anulados que se tratam como inexistentes (o "sem" do relatório do admin): as
 *   linhas `trade` deles saem da conta, em qualquer horário.
 */
export interface ReadOptions {
  ignoreTrades?: ReadonlySet<number>;
}

/** Junta o negócio original das linhas `trade_annulled`, para `effectiveAt` valer o horário dele. */
const ORIGINAL_TRADE_JOIN = sql`left join futbolsa.trades ot on ot.id = case when e.kind = 'trade_annulled' and e.ref_type = 'trade' then e.ref_id::bigint end`;

/** Quando a linha conta: o horário do negócio, se ela desfaz um; senão o dela. */
const EFFECTIVE_AT = sql`coalesce(ot.at, e.at)`;

/** A linha sai da conta de `at`: é depois dele, é do fechamento, ou é de um negócio ignorado. */
function removedFrom(iso: string, ignore: ReadonlySet<number> | undefined): SQL {
  const base = sql`(${EFFECTIVE_AT} > ${iso}::timestamptz or e.kind = 'season_close'`;
  if (!ignore || ignore.size === 0) return sql`${base})`;
  return sql`${base} or (e.kind = 'trade' and e.ref_type = 'trade' and e.ref_id in (${sql.join([...ignore].map((id) => sql`${String(id)}`), sql`, `)})))`;
}

export interface BalanceRow {
  walletId: number;
  cash: Cents;
  reserved: Cents;
}

export interface HoldingRow {
  walletId: number;
  clubId: number;
  shares: number;
}

/**
 * Caixa e ações de cada carteira em `at`: o estado de hoje **menos** os movimentos depois de `at`. As linhas
 * `season_close` contam sempre como "depois", para o patrimônio final do encerramento não sair zero. Só `SELECT`; roda
 * no `tx` de quem chama. Carteiras que entraram depois de `at` não aparecem.
 */
export async function balancesAt(tx: Tx, seasonId: number, at: Date, walletIds?: readonly number[], options: ReadOptions = {}): Promise<BalanceRow[]> {
  const iso = at.toISOString();
  const result = await tx.db.execute(sql`
    select w.id as wallet_id,
           (w.cash - coalesce(l.cash_delta, 0))::bigint as cash,
           w.reserved_cash::bigint as reserved
    from futbolsa.wallets w
    left join (
      select e.wallet_id, sum(e.cash_delta) as cash_delta
      from futbolsa.wallet_entries e
      join futbolsa.wallets w2 on w2.id = e.wallet_id
      ${ORIGINAL_TRADE_JOIN}
      where ${walletFilter(seasonId, walletIds, "w2")} and ${removedFrom(iso, options.ignoreTrades)}
      group by e.wallet_id
    ) l on l.wallet_id = w.id
    where ${walletFilter(seasonId, walletIds, "w")} and w.entered_at <= ${iso}::timestamptz`);
  return result.rows.map((r) => ({ walletId: Number(r.wallet_id), cash: Number(r.cash), reserved: Number(r.reserved) }));
}

export async function holdingsAt(tx: Tx, seasonId: number, at: Date, walletIds?: readonly number[], options: ReadOptions = {}): Promise<HoldingRow[]> {
  const iso = at.toISOString();
  const result = await tx.db.execute(sql`
    select p.wallet_id, p.club_id, (p.shares - coalesce(l.shares_delta, 0))::int as shares
    from futbolsa.positions p
    join futbolsa.wallets w on w.id = p.wallet_id
    left join (
      select e.wallet_id, e.club_id, sum(e.shares_delta) as shares_delta
      from futbolsa.wallet_entries e
      join futbolsa.wallets w2 on w2.id = e.wallet_id
      ${ORIGINAL_TRADE_JOIN}
      where ${walletFilter(seasonId, walletIds, "w2")} and e.club_id is not null
        and ${removedFrom(iso, options.ignoreTrades)}
      group by e.wallet_id, e.club_id
    ) l on l.wallet_id = p.wallet_id and l.club_id = p.club_id
    where ${walletFilter(seasonId, walletIds, "w")} and w.entered_at <= ${iso}::timestamptz
      and (p.shares - coalesce(l.shares_delta, 0)) > 0`);
  return result.rows.map((r) => ({ walletId: Number(r.wallet_id), clubId: Number(r.club_id), shares: Number(r.shares) }));
}
