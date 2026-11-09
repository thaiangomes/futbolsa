import { sql } from "drizzle-orm";
import { type Executor, executorOf } from "./holdings.js";

/**
 * Os eventos vigentes aprovados da temporada que ainda estão **liquidando**: com valor por ação acima de zero e com
 * menos linhas em `payout_credits` do que carteiras que recebem na foto (bots e jogadores, inclusive os bloqueados;
 * a conta excluída não recebe, P6, e a tesouraria nunca está na foto). É a mesma regra do `settlement` da prévia
 * (`PreviewService`: liquidado quando os créditos alcançam as carteiras que recebem), numa consulta só para a temporada.
 *
 * A correção recusa enquanto houver algum (`payout_settling`), para o estorno não ser calculado sobre um pagamento
 * pela metade (Plano dos dividendos e pagamentos, "Plano da correção").
 */
export async function settlingEventIds(executor: Executor, seasonId: number): Promise<number[]> {
  const result = await executorOf(executor).execute(sql`
    select e.id
    from futbolsa.payout_events e
    where e.season_id = ${seasonId} and e.status = 'approved' and e.per_share > 0
      and (
        select count(*)
        from futbolsa.payout_holdings h
        join futbolsa.wallets w on w.id = h.wallet_id
        left join futbolsa.users u on u.id = w.user_id
        where h.event_id = e.id and (w.owner_type = 'bot' or (w.owner_type = 'user' and u.status <> 'deleted'))
      ) > (select count(*) from futbolsa.payout_credits c where c.event_id = e.id)
    order by e.id`);
  return result.rows.map((r) => Number(r.id));
}
