import { sql } from "drizzle-orm";
import type { Cents } from "@futbolsa/engine";
import type { Tx } from "../../../../infra/db/transaction.js";
import { walletFilter } from "./balances-at.js";

export interface PayableRow {
  walletId: number;
  clubId: number;
  /** Ações da foto × valor por ação da versão atual − o que já caiu no caixa até `at`. */
  amount: Cents;
}

/**
 * Dividendos e recompra a receber em `at`, por carteira e clube (a conta de `receivable` do motor, em lote): eventos
 * vigentes com `closed_at ≤ at`, as ações da foto do evento, o valor por ação da versão atual e, descontado, a soma
 * dos créditos de **todas** as versões da mesma chave com o lançamento até `at`. Passar do "a receber" para o caixa não
 * conta duas vezes porque o crédito entra no desconto. Uma consulta, sem laço por carteira.
 */
export async function payablesAt(tx: Tx, seasonId: number, at: Date, walletIds?: readonly number[]): Promise<PayableRow[]> {
  const iso = at.toISOString();
  const result = await tx.db.execute(sql`
    with due as (
      select h.wallet_id, pe.club_id, pe.event_key, h.shares::bigint * pe.per_share as due
      from futbolsa.payout_events pe
      join futbolsa.payout_holdings h on h.event_id = pe.id
      join futbolsa.wallets w on w.id = h.wallet_id
      where pe.season_id = ${seasonId} and pe.status <> 'superseded' and pe.closed_at <= ${iso}::timestamptz
        and ${walletFilter(seasonId, walletIds, "w")}
    ),
    paid as (
      select pc.wallet_id, pe.club_id, pe.event_key, sum(pc.amount) as credited
      from futbolsa.payout_credits pc
      join futbolsa.payout_events pe on pe.id = pc.event_id
      join futbolsa.wallet_entries e on e.id = pc.entry_id
      join futbolsa.wallets w on w.id = pc.wallet_id
      where pe.season_id = ${seasonId} and pe.closed_at <= ${iso}::timestamptz and e.at <= ${iso}::timestamptz
        and ${walletFilter(seasonId, walletIds, "w")}
      group by pc.wallet_id, pe.club_id, pe.event_key
    )
    select coalesce(d.wallet_id, p.wallet_id) as wallet_id, coalesce(d.club_id, p.club_id) as club_id,
           sum(coalesce(d.due, 0) - coalesce(p.credited, 0))::bigint as amount
    from due d
    full join paid p on p.wallet_id = d.wallet_id and p.club_id = d.club_id and p.event_key = d.event_key
    group by 1, 2
    having sum(coalesce(d.due, 0) - coalesce(p.credited, 0)) <> 0`);
  return result.rows.map((r) => ({ walletId: Number(r.wallet_id), clubId: Number(r.club_id), amount: Number(r.amount) }));
}
