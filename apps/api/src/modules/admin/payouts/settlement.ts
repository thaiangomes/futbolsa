import { sql, type SQL } from "drizzle-orm";
import { type Executor, executorOf } from "./holdings.js";

/**
 * Quem recebe e devolve (P6): bots e jogadores, inclusive os bloqueados; a conta excluída não recebe nem devolve, e a
 * tesouraria nunca (ela não está na foto; fica de fora aqui também). A mesma regra da prévia e do plano da correção.
 */
const RECEIVES = sql.raw(`(w.owner_type = 'bot' or (w.owner_type = 'user' and u.status <> 'deleted'))`);

/** O que falta lançar numa carteira por um evento aprovado. */
export interface Due {
  eventId: number;
  walletId: number;
  /** Ações da carteira na foto desta versão (0 quando ela só está nas versões anteriores). */
  shares: number;
  /** Positivo cai no caixa (dividendo ou complemento); negativo é o estorno. Nunca zero. */
  amount: number;
}

export interface DuesFilter {
  /** Um evento só; sem ele, todos os aprovados vigentes de `seasonId`. */
  eventId?: number;
  seasonId?: number;
  eventIds?: readonly number[];
  walletIds?: readonly number[];
  /** Só as carteiras de id maior (o cursor dos lotes). */
  afterWallet?: number;
  limit?: number;
}

const list = (ids: readonly number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/**
 * O que falta lançar por evento e carteira (Plano dos dividendos e pagamentos, "Versões de um evento" e "Aplicar a
 * correção"). O que uma carteira deve ter recebido por uma chave, somando **todas** as versões, é as ações na foto da
 * versão vigente × o valor por ação vigente; o que falta lançar na versão vigente é isso menos o que as versões
 * anteriores já creditaram (ou estornaram). Na primeira versão não há nada antes, e o que falta é ações × valor (o
 * dividendo da aprovação, T5); numa versão da correção é o **líquido** da carteira (T7), igual ao do `settle` do
 * plano quando as versões anteriores estavam liquidadas, o que a correção confere antes de aplicar.
 *
 * Por isso a lista sai das carteiras da foto vigente **e** das que receberam nas versões anteriores (quem vendeu tudo
 * entre o fechamento antigo e o novo devolve, sem estar na foto nova). A carteira com o líquido zero não precisa de
 * linha em `payout_credits`, e a que já tem a linha nesta versão está feita.
 *
 * Só carteiras que recebem: a conta excluída fica de fora mesmo que tenha sido creditada antes da exclusão (ela não
 * recebe nem devolve, P6), então ela nunca deixa um evento "liquidando" nem esconde o crédito que falta de outra.
 *
 * Em conjuntos (revisão T10): a foto e o já creditado pelas versões anteriores entram por junção, nunca por subconsulta
 * por carteira. Com subconsultas correlacionadas, cada carteira de cada evento relia os eventos da temporada (as
 * versões antigas não estão em índice nenhum por chave), e `settlingEventIds` da temporada inteira, que a tarefa de
 * cada minuto, a correção e a visão geral do admin chamam, levava ~18 s com 200 eventos pagos de 2.000 donos. O filtro
 * de carteiras entra na foto e nos créditos antes da junção, então o lote e o cursor só leem as carteiras deles.
 */
export function duesQuery(filter: DuesFilter): SQL {
  const where: SQL[] = [sql`e.status = 'approved'`];
  if (filter.eventId !== undefined) where.push(sql`e.id = ${filter.eventId}`);
  if (filter.seasonId !== undefined) where.push(sql`e.season_id = ${filter.seasonId}`);
  if (filter.eventIds) where.push(filter.eventIds.length === 0 ? sql`false` : sql`e.id in (${list(filter.eventIds)})`);
  const walletsOf = (column: SQL): SQL => {
    const parts: SQL[] = [];
    if (filter.walletIds) parts.push(filter.walletIds.length === 0 ? sql`false` : sql`${column} in (${list(filter.walletIds)})`);
    if (filter.afterWallet !== undefined) parts.push(sql`${column} > ${filter.afterWallet}`);
    return parts.length > 0 ? sql`and ${sql.join(parts, sql` and `)}` : sql``;
  };
  return sql`
    with ev as (
      select e.id, e.season_id, e.club_id, e.event_key, e.version, e.per_share
      from futbolsa.payout_events e
      where ${sql.join(where, sql` and `)}
    ),
    hold as (
      select h.event_id, h.wallet_id, h.shares
      from ev join futbolsa.payout_holdings h on h.event_id = ev.id
      where true ${walletsOf(sql`h.wallet_id`)}
    ),
    prev as (
      select ev.id as event_id, pc.wallet_id, sum(pc.amount)::bigint as paid
      from ev
      join futbolsa.payout_events o
        on o.season_id = ev.season_id and o.club_id = ev.club_id and o.event_key = ev.event_key and o.version < ev.version
      join futbolsa.payout_credits pc on pc.event_id = o.id
      where true ${walletsOf(sql`pc.wallet_id`)}
      group by ev.id, pc.wallet_id
    ),
    d as (
      select coalesce(hold.event_id, prev.event_id) as event_id,
        coalesce(hold.wallet_id, prev.wallet_id) as wallet_id,
        coalesce(hold.shares, 0) as shares,
        coalesce(prev.paid, 0)::bigint as paid
      from hold full join prev on prev.event_id = hold.event_id and prev.wallet_id = hold.wallet_id
    )
    select d.event_id, d.wallet_id, d.shares, d.shares::bigint * ev.per_share - d.paid as amount
    from d
    join ev on ev.id = d.event_id
    join futbolsa.wallets w on w.id = d.wallet_id
    left join futbolsa.users u on u.id = w.user_id
    where ${RECEIVES} and d.shares::bigint * ev.per_share - d.paid <> 0
      and not exists (select 1 from futbolsa.payout_credits pc where pc.event_id = d.event_id and pc.wallet_id = d.wallet_id)
    order by d.event_id, d.wallet_id
    ${filter.limit === undefined ? sql`` : sql`limit ${filter.limit}`}`;
}

/** O que falta lançar, em ordem de evento e carteira. */
export async function dues(executor: Executor, filter: DuesFilter): Promise<Due[]> {
  const result = await executorOf(executor).execute(duesQuery(filter));
  return result.rows.map((r) => ({
    eventId: Number(r.event_id),
    walletId: Number(r.wallet_id),
    shares: Number(r.shares),
    amount: Number(r.amount),
  }));
}

/**
 * Os eventos vigentes aprovados da temporada que ainda estão **liquidando**: com alguma carteira que recebe e ainda não
 * tem a linha em `payout_credits` do que falta (veja `dues`). Na aprovação comum é a carteira da foto sem o dividendo;
 * na correção, a carteira com o líquido diferente de zero sem o complemento ou o estorno.
 *
 * A correção recusa enquanto houver algum (`payout_settling`), para o estorno não ser calculado sobre um pagamento
 * pela metade, e a tarefa de liquidação continua por eles (Plano dos dividendos e pagamentos, "Plano da correção").
 */
export async function settlingEventIds(executor: Executor, seasonId: number, eventIds?: readonly number[]): Promise<number[]> {
  const result = await executorOf(executor).execute(sql`
    select distinct q.event_id from (${duesQuery({ seasonId, eventIds })}) q order by q.event_id`);
  return result.rows.map((r) => Number(r.event_id));
}

/**
 * O motivo do admin, quando a versão do evento foi gravada por uma correção (`payout.correct`, que guarda no registro
 * os ids das versões novas em `after.eventIds`); `null` na versão comum. A liquidação usa para lançar complemento e
 * estorno com o motivo, em vez de dividendo.
 */
export async function correctionReasonOf(executor: Executor, eventId: number): Promise<string | null> {
  const result = await executorOf(executor).execute(sql`
    select reason from futbolsa.admin_log
    where action = 'payout.correct' and after -> 'eventIds' @> ${JSON.stringify([eventId])}::jsonb
    order by id limit 1`);
  const row = result.rows[0];
  return row ? String(row.reason) : null;
}
