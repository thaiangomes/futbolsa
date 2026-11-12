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

/**
 * Nenhum livro cruzado fora de leilão (Plano do livro de ofertas e formador, "Testes"): em cada clube da
 * temporada, a melhor compra aberta fica abaixo da melhor venda aberta. O clube em leilão
 * (`auction_opened_at` preenchido) fica de fora: nele as ordens esperam o preço único e o livro pode cruzar.
 */
export async function assertBookNotCrossed(db: Database, seasonId: number): Promise<void> {
  fail(
    "livro cruzado fora de leilão (melhor compra igual ou acima da melhor venda)",
    await problems(
      db,
      sql`select c.ticker, b.best_bid, a.best_ask
          from futbolsa.season_clubs sc
          join futbolsa.clubs c on c.id = sc.club_id
          cross join lateral (
            select max(o.limit_price) as best_bid from futbolsa.orders o
            where o.season_id = sc.season_id and o.club_id = sc.club_id and o.side = 'buy' and o.status = 'open') b
          cross join lateral (
            select min(o.limit_price) as best_ask from futbolsa.orders o
            where o.season_id = sc.season_id and o.club_id = sc.club_id and o.side = 'sell' and o.status = 'open') a
          where sc.season_id = ${seasonId} and sc.auction_opened_at is null and b.best_bid >= a.best_ask`,
    ),
  );
}

/** `wallets.open_orders` de cada carteira da temporada é o número de ordens abertas dela (o limite de 50 conta por ele). */
export async function assertOpenOrdersCounter(db: Database, seasonId: number): Promise<void> {
  fail(
    "open_orders diferente do número de ordens abertas da carteira",
    await problems(
      db,
      sql`select w.id, w.open_orders, count(o.id)::int as open_in_book
          from futbolsa.wallets w
          left join futbolsa.orders o on o.wallet_id = w.id and o.status = 'open'
          where w.season_id = ${seasonId}
          group by w.id
          having w.open_orders <> count(o.id)`,
    ),
  );
}

/**
 * As reservas batem com o livro: a compra limitada aberta prende o que falta executar × o preço limite, e só ela
 * prende caixa; o caixa reservado da carteira é a soma das compras abertas mais as ofertas ativas do IPO; as ações
 * reservadas de cada posição são o que falta executar das vendas abertas dela no clube.
 */
export async function assertReservesMatchOrders(db: Database, seasonId: number): Promise<void> {
  fail(
    "reserved_cash da ordem diferente do que falta executar × o preço limite",
    await problems(
      db,
      sql`select o.id, o.side, o.type, o.status, o.quantity, o.filled, o.limit_price, o.reserved_cash
          from futbolsa.orders o
          where o.season_id = ${seasonId}
            and o.reserved_cash <> case when o.status = 'open' and o.side = 'buy' then (o.quantity - o.filled) * o.limit_price else 0 end`,
    ),
  );
  fail(
    "caixa reservado da carteira diferente das compras abertas e das ofertas do IPO",
    await problems(
      db,
      sql`select w.id, w.reserved_cash,
            (select coalesce(sum(o.reserved_cash), 0) from futbolsa.orders o where o.wallet_id = w.id and o.status = 'open')::bigint as in_orders,
            (select coalesce(sum(b.reserved), 0) from futbolsa.ipo_bids b where b.wallet_id = w.id and b.status = 'active')::bigint as in_bids
          from futbolsa.wallets w
          where w.season_id = ${seasonId}
            and w.reserved_cash <>
              (select coalesce(sum(o.reserved_cash), 0) from futbolsa.orders o where o.wallet_id = w.id and o.status = 'open')
              + (select coalesce(sum(b.reserved), 0) from futbolsa.ipo_bids b where b.wallet_id = w.id and b.status = 'active')`,
    ),
  );
  fail(
    "ações reservadas diferentes do que falta executar das vendas abertas",
    await problems(
      db,
      sql`with selling as (
            select o.wallet_id, o.club_id, sum(o.quantity - o.filled)::bigint as reserved
            from futbolsa.orders o
            where o.season_id = ${seasonId} and o.side = 'sell' and o.status = 'open'
            group by o.wallet_id, o.club_id)
          select coalesce(p.wallet_id, s.wallet_id) as wallet_id, coalesce(p.club_id, s.club_id) as club_id,
            coalesce(p.reserved_shares, 0) as reserved_shares, coalesce(s.reserved, 0) as in_orders
          from (select p.* from futbolsa.positions p join futbolsa.wallets w on w.id = p.wallet_id
                where w.season_id = ${seasonId}) p
          full join selling s on s.wallet_id = p.wallet_id and s.club_id = p.club_id
          where coalesce(p.reserved_shares, 0) <> coalesce(s.reserved, 0)`,
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

/**
 * Os candles de 15 minutos e diários de cada clube são iguais à soma dos negócios (abertura = primeiro, fechamento =
 * último, máxima, mínima e volume). O dia é de 0h a 24h de Brasília. A F16 reaproveita.
 */
export async function assertCandlesMatchTrades(db: Database, seasonId: number): Promise<void> {
  const found: string[] = [];
  for (const [interval, bucket] of [
    ["15m", sql`to_timestamp(floor(extract(epoch from t.at) / 900) * 900)`],
    ["1d", sql`(date_trunc('day', t.at at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo'`],
  ] as const) {
    found.push(
      ...(await problems(
        db,
        sql`
          with agg as (
            select t.club_id, ${bucket} as start,
                   (array_agg(t.price order by t.at, t.id))[1] as open,
                   max(t.price) as high, min(t.price) as low,
                   (array_agg(t.price order by t.at desc, t.id desc))[1] as close,
                   sum(t.quantity) as volume
            from futbolsa.trades t where t.season_id = ${seasonId} group by 1, 2
          )
          select coalesce(a.club_id, c.club_id) as club_id, ${interval}::text as interval, coalesce(a.start, c.start) as start,
                 a.open as trades_open, c.open as candle_open, a.close as trades_close, c.close as candle_close,
                 a.volume as trades_volume, c.volume as candle_volume
          from agg a
          full join (select * from futbolsa.candles where interval = ${interval} and club_id in (select club_id from futbolsa.season_clubs where season_id = ${seasonId})) c
            on c.club_id = a.club_id and c.start = a.start
          where a.club_id is null or c.club_id is null
             or a.open <> c.open or a.high <> c.high or a.low <> c.low or a.close <> c.close or a.volume <> c.volume`,
      )),
    );
  }
  fail("os candles não batem com os negócios", found);
}
