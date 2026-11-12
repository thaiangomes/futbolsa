import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { dayStart, type Cents } from "@futbolsa/engine";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";
import { clubs, seasonClubs, trades } from "../../../infra/db/schema/index.js";

type Db = Database | DrizzleTx;

/**
 * O preço exibido de um clube: o último negócio (inclusive com a casa); antes do primeiro, o preço do IPO. A F8
 * grava o preço de corte em `last_price` na liquidação, então na prática vale `last_price`; o `ipo_price` é a
 * rede de segurança da especificação ("antes do primeiro, o preço do IPO"). Função pura, para a linha que o
 * `lockClubs` devolve.
 */
export function displayedPriceOf(club: { lastPrice: Cents | null; ipoPrice: Cents | null }): Cents {
  const price = club.lastPrice ?? club.ipoPrice;
  if (price === null) throw new Error("clube sem preço exibido nem preço de IPO");
  return price;
}

/**
 * Variação em centésimos de ponto percentual (+5,00% = 500) do preço atual contra o de referência (o preço exibido
 * às 0h de Brasília). Arredonda para o mais perto, a metade para longe do zero (critério 20).
 */
export function changeBp(current: Cents, reference: Cents): number {
  if (reference <= 0) throw new Error("referência da variação deve ser positiva");
  const diff = current - reference;
  const magnitude = Math.floor((Math.abs(diff) * 10_000 * 2 + reference) / (reference * 2));
  return diff < 0 ? -magnitude : magnitude;
}

/**
 * O último negócio do clube até `at` (inclusive). Único ponto que lê os negócios para o preço do passado, para a
 * anulação de trapaça da F14 acrescentar o filtro dos negócios anulados num lugar só. Usa `trades_club_at_idx`.
 * Com `only`, olha só os negócios desde um instante (`since`, inclusive) ou só os de leilão: é como a referência
 * do túnel acha o último leilão de hoje (`rebuildTunnelReference`).
 */
export async function lastTradeUntil(
  db: Db,
  clubId: number,
  at: Date,
  only: { since?: Date; inAuction?: boolean } = {},
): Promise<{ price: Cents; at: Date } | null> {
  const [row] = await db
    .select({ price: trades.price, at: trades.at })
    .from(trades)
    .where(
      and(
        eq(trades.clubId, clubId),
        lte(trades.at, at),
        only.since ? gte(trades.at, only.since) : undefined,
        only.inAuction === undefined ? undefined : eq(trades.inAuction, only.inAuction),
      ),
    )
    .orderBy(desc(trades.at), desc(trades.id))
    .limit(1);
  return row ?? null;
}

async function clubRow(db: Db, seasonId: number, ticker: string) {
  const [row] = await db
    .select({ clubId: seasonClubs.clubId, lastPrice: seasonClubs.lastPrice, ipoPrice: seasonClubs.ipoPrice })
    .from(seasonClubs)
    .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
    .where(and(eq(seasonClubs.seasonId, seasonId), eq(clubs.ticker, ticker)));
  if (!row) throw new Error(`clube não listado na temporada ${seasonId}: ${ticker}`);
  return row;
}

/**
 * O preço exibido do clube, sem trava. Sem `at`, o de agora (`last_price` da linha). Com `at`, o do passado: o
 * último negócio até o instante, ou o preço do IPO antes do primeiro (para o `portfolio`, os `rankings` e a
 * entrada no meio da temporada).
 */
export async function displayedPrice(db: Db, seasonId: number, ticker: string, at?: Date): Promise<Cents> {
  const club = await clubRow(db, seasonId, ticker);
  if (!at) return displayedPriceOf(club);
  const last = await lastTradeUntil(db, club.clubId, at);
  return last ? last.price : displayedPriceOf({ lastPrice: null, ipoPrice: club.ipoPrice ?? club.lastPrice });
}

/** O preço exibido de todos os clubes da temporada num instante, por ticker (a F13 usa no fechamento do mês). */
export async function displayedPrices(db: Db, seasonId: number, at: Date): Promise<Map<string, Cents>> {
  const result = await db.execute(sql`
    select c.ticker as ticker,
           coalesce(
             (select t.price from futbolsa.trades t
               where t.club_id = sc.club_id and t.season_id = sc.season_id and t.at <= ${at.toISOString()}::timestamptz
               order by t.at desc, t.id desc limit 1),
             sc.ipo_price, sc.last_price) as price
    from futbolsa.season_clubs sc
    join futbolsa.clubs c on c.id = sc.club_id
    where sc.season_id = ${seasonId}`);
  return new Map(result.rows.map((r) => [String(r.ticker), Number(r.price)]));
}

/** O preço exibido às 0h de Brasília do dia de `now`: a base da variação do dia e da referência do túnel. */
export async function dayOpenPrice(db: Db, seasonId: number, ticker: string, now: Date): Promise<Cents> {
  return displayedPrice(db, seasonId, ticker, new Date(dayStart(now.getTime())));
}
