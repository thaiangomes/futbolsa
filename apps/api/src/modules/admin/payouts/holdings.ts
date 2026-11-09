import { sql, type SQL } from "drizzle-orm";
import { type Database, type DrizzleTx, Tx } from "../../../infra/db/index.js";
import { payoutHoldings } from "../../../infra/db/schema/index.js";

/** Quem lê ou grava: o `Tx` da transação, a transação do Drizzle ou o banco (fora de transação). */
export type Executor = Tx | Database | DrizzleTx;

export const executorOf = (e: Executor): Database | DrizzleTx => (e instanceof Tx ? e.db : e);

/** As ações de uma carteira na foto do fechamento de um evento. */
export interface Holding {
  walletId: number;
  shares: number;
}

/** Linhas por `INSERT` ao gravar a foto: um evento com milhares de donos vira poucos comandos. */
export const HOLDINGS_BATCH = 1_000;

/**
 * A consulta da foto, exportada para o teste conferir o plano (o índice do extrato).
 *
 * Parte das ações de hoje (`positions.shares`, que já conta as presas em ordens de venda; a reserva é outra
 * coluna) e desfaz só o que o extrato do clube mudou **depois** do fechamento: para cada carteira, a soma de
 * `shares_delta` das linhas com `at > fechamento`, lida pelo índice (`wallet_id`, `club_id`, `at`) numa faixa
 * curta, porque o fechamento é recente. Quem vendeu tudo depois do fechamento tem hoje 0 (ou nem tem a linha em
 * `positions`) e aparece pela soma das linhas depois; por isso a consulta parte das carteiras da temporada, e
 * não das posições.
 *
 * Uma consulta só: no `READ COMMITTED` cada comando lê um retrato do banco, então as posições e o extrato
 * saem do mesmo instante, sem um negócio entre uma leitura e a outra.
 */
export function holdingsQuery(seasonId: number, clubId: number, at: Date): SQL {
  return sql`
    select w.id as wallet_id, (coalesce(p.shares, 0) - coalesce(later.delta, 0))::int as shares
    from futbolsa.wallets w
    left join futbolsa.positions p on p.wallet_id = w.id and p.club_id = ${clubId}
    left join lateral (
      select sum(e.shares_delta) as delta
      from futbolsa.wallet_entries e
      where e.wallet_id = w.id and e.club_id = ${clubId} and e.at > ${at.toISOString()}::timestamptz
    ) later on true
    where w.season_id = ${seasonId} and w.owner_type <> 'treasury'
      and coalesce(p.shares, 0) - coalesce(later.delta, 0) <> 0
    order by w.id`;
}

/**
 * Foto das posições de um clube no instante `at` (o fechamento de um evento): as ações de cada carteira da
 * temporada, **sem a tesouraria** (ela não recebe dividendo), em ordem de carteira e só as que tinham ações.
 *
 * Regras do jogo (Admin, critérios 3 e 4; Plano dos dividendos e pagamentos, "Foto das posições"):
 * - quem tinha as ações no fechamento recebe; comprar ou vender depois não muda quem recebe;
 * - uma linha do extrato com `at` **igual** ao fechamento conta como antes dele (o negócio no apito vale);
 * - entram as ações presas em ordens de venda, as dos bots, as dos jogadores bloqueados e as das contas
 *   excluídas depois do fechamento (a foto é o que era; quem não recebe é decisão da aprovação, P6);
 * - **cada linha conta pelo próprio horário real (`at`)** (acréscimo de 2026-11-07, proposta 19 do Plano do
 *   admin de jogadores e bots): a linha `trade_annulled` da anulação por trapaça entra com o horário da
 *   anulação, não com o do negócio desfeito, então uma anulação depois do fechamento não muda a foto de evento
 *   nenhum, nem a de um já pago, nem a de um pendente já gravado.
 *
 * Quem chama garante que o fechamento está ao menos 2 minutos no passado (P8): nenhuma transação com horário
 * anterior a ele ainda está para fazer `COMMIT`.
 */
export async function holdingsAt(executor: Executor, seasonId: number, clubId: number, at: Date): Promise<Holding[]> {
  const result = await executorOf(executor).execute(holdingsQuery(seasonId, clubId, at));
  const holdings = result.rows.map((r) => ({ walletId: Number(r.wallet_id), shares: Number(r.shares) }));
  const negative = holdings.find((h) => h.shares < 0);
  if (negative) {
    // só acontece com o extrato inconsistente (uma linha com horário anterior às ações que ela tira):
    // pagar por uma foto assim seria errado, então para em vez de ignorar a carteira
    throw new Error(
      `foto inválida: carteira ${negative.walletId} com ${negative.shares} ações do clube ${clubId} em ${at.toISOString()}`,
    );
  }
  return holdings;
}

/** A foto no formato do `settle` do motor: id da carteira em texto, na mesma ordem. */
export function holdingsMap(holdings: readonly Holding[]): Map<string, number> {
  return new Map(holdings.map((h) => [String(h.walletId), h.shares]));
}

/**
 * Grava a foto de um evento em `payout_holdings` (histórico imutável), em lotes de `HOLDINGS_BATCH` linhas.
 * Só entram as carteiras com ações (a tabela recusa zero). Devolve quantas linhas gravou.
 */
export async function writeHoldings(executor: Executor, eventId: number, holdings: readonly Holding[]): Promise<number> {
  const db = executorOf(executor);
  const rows = holdings.filter((h) => h.shares > 0).map((h) => ({ eventId, walletId: h.walletId, shares: h.shares }));
  for (let i = 0; i < rows.length; i += HOLDINGS_BATCH) {
    await db.insert(payoutHoldings).values(rows.slice(i, i + HOLDINGS_BATCH));
  }
  return rows.length;
}

/**
 * Copia a foto de uma versão do evento para a versão nova (o fechamento não mudou, então quem recebe também
 * não: Plano dos dividendos e pagamentos, "Versões de um evento"). Devolve quantas linhas copiou.
 */
export async function copyHoldings(executor: Executor, fromEventId: number, toEventId: number): Promise<number> {
  const result = await executorOf(executor).execute(sql`
    insert into futbolsa.payout_holdings (event_id, wallet_id, shares)
    select ${toEventId}, wallet_id, shares from futbolsa.payout_holdings where event_id = ${fromEventId}`);
  return result.rowCount ?? 0;
}
