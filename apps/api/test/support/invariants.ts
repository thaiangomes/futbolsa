import { sql } from "drizzle-orm";
import type { Database } from "../../src/infra/db/client.js";

/**
 * Verificadores das invariantes do dinheiro e das ações, para os testes desta fase e
 * das seguintes (Arquitetura da Fase 1, "Testes"). Cada um junta todos os problemas
 * achados e falha com a lista.
 */

async function problems(db: Database, query: ReturnType<typeof sql>): Promise<string[]> {
  const result = await db.execute(query);
  return result.rows.map((r) => JSON.stringify(r));
}

function fail(title: string, found: string[]): void {
  if (found.length > 0) throw new Error(`${title}:\n${found.slice(0, 20).join("\n")}`);
}

/**
 * O estado (`wallets`, `positions`) é a soma do extrato; o `cash_after` de cada linha
 * é a soma até ela; nenhuma reserva passa do total; caixa negativo só sem reserva.
 */
export async function assertLedgerConsistent(db: Database, seasonId: number): Promise<void> {
  fail(
    "carteira diferente da soma do extrato",
    await problems(
      db,
      sql`select w.id, w.cash, w.reserved_cash, w.open_orders,
            coalesce(sum(e.cash_delta), 0)::bigint as cash_sum,
            coalesce(sum(e.reserved_cash_delta), 0)::bigint as reserved_sum
          from futbolsa.wallets w
          left join futbolsa.wallet_entries e on e.wallet_id = w.id
          where w.season_id = ${seasonId}
          group by w.id
          having w.cash <> coalesce(sum(e.cash_delta), 0) or w.reserved_cash <> coalesce(sum(e.reserved_cash_delta), 0)`,
    ),
  );
  fail(
    "posição diferente da soma do extrato",
    await problems(
      db,
      sql`with sums as (
            select e.wallet_id, e.club_id,
              sum(e.shares_delta)::bigint as shares,
              sum(e.reserved_shares_delta)::bigint as reserved,
              sum(case when e.kind in ('dividend', 'reversal', 'complement') then e.cash_delta else 0 end)::bigint as dividends
            from futbolsa.wallet_entries e
            join futbolsa.wallets w on w.id = e.wallet_id
            where w.season_id = ${seasonId} and e.club_id is not null
            group by e.wallet_id, e.club_id)
          select coalesce(p.wallet_id, s.wallet_id) as wallet_id, coalesce(p.club_id, s.club_id) as club_id,
            p.shares, s.shares as shares_sum, p.reserved_shares, s.reserved as reserved_sum,
            p.dividends, s.dividends as dividends_sum
          from (select p.* from futbolsa.positions p join futbolsa.wallets w on w.id = p.wallet_id
                where w.season_id = ${seasonId}) p
          full join sums s on s.wallet_id = p.wallet_id and s.club_id = p.club_id
          where p.wallet_id is null or s.wallet_id is null
            or p.shares <> s.shares or p.reserved_shares <> s.reserved or p.dividends <> s.dividends`,
    ),
  );
  fail(
    "cash_after diferente da soma até a linha",
    await problems(
      db,
      sql`select id, wallet_id, cash_after, running from (
            select e.id, e.wallet_id, e.cash_after,
              sum(e.cash_delta) over (partition by e.wallet_id order by e.id) as running
            from futbolsa.wallet_entries e
            join futbolsa.wallets w on w.id = e.wallet_id
            where w.season_id = ${seasonId}) x
          where cash_after <> running`,
    ),
  );
  fail(
    "reserva acima do total ou caixa negativo com reserva",
    await problems(
      db,
      sql`select id, cash, reserved_cash from futbolsa.wallets
          where season_id = ${seasonId} and (reserved_cash < 0 or (cash < reserved_cash and reserved_cash <> 0))
          union all
          select p.wallet_id, p.shares, p.reserved_shares from futbolsa.positions p
          join futbolsa.wallets w on w.id = p.wallet_id
          where w.season_id = ${seasonId} and (p.reserved_shares < 0 or p.reserved_shares > p.shares)`,
    ),
  );
}

/**
 * As ações de cada clube, somadas em todas as carteiras (inclusive a tesouraria), são
 * `season_clubs.total_shares`: oferta + lote + emitidas para novatos.
 */
export async function assertSharesConserved(db: Database, seasonId: number): Promise<void> {
  fail(
    "ações do clube diferentes do total emitido",
    await problems(
      db,
      sql`select sc.club_id, sc.total_shares, coalesce(sum(p.shares), 0)::bigint as held
          from futbolsa.season_clubs sc
          left join futbolsa.wallets w on w.season_id = sc.season_id
          left join futbolsa.positions p on p.wallet_id = w.id and p.club_id = sc.club_id
          where sc.season_id = ${seasonId}
          group by sc.club_id, sc.total_shares
          having sc.total_shares <> coalesce(sum(p.shares), 0)`,
    ),
  );
}

/** Soma do caixa de todas as carteiras da temporada. */
export async function totalCash(db: Database, seasonId: number): Promise<number> {
  const result = await db.execute(
    sql`select coalesce(sum(cash), 0)::bigint as total from futbolsa.wallets where season_id = ${seasonId}`,
  );
  return Number(result.rows[0]!.total);
}
