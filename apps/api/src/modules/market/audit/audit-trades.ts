import { and, desc, eq, gte, lt, or, sql, type SQL } from "drizzle-orm";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";
import { clubs, trades } from "../../../infra/db/schema/index.js";

/**
 * A consulta de negócios da auditoria do admin (F14, T7). O `market` é o dono de `trades` e só ele os lê; devolve as
 * **carteiras** dos dois lados, e quem resolve os donos (apelido, bot, casa) é o `admin`. A contraparte nunca sai daqui
 * para fora do `/admin`: o livro, o evento `trade` e o extrato do jogador continuam sem ela.
 */
export interface AuditTradesFilter {
  seasonId: number;
  /** Negócios em que esta carteira comprou ou vendeu. */
  wallet?: number;
  /** Só os negócios entre as duas carteiras, em qualquer lado. */
  pair?: readonly [number, number];
  ticker?: string;
  /** `from` inclusive e `to` exclusive. */
  from?: Date;
  to?: Date;
  /** A posição da última linha da página anterior. */
  after?: { at: Date; id: number };
  limit: number;
}

export interface AuditTradeRow {
  id: number;
  at: Date;
  clubId: number;
  ticker: string;
  quantity: number;
  price: number;
  inAuction: boolean;
  /** O preço exibido antes do negócio (a base do alerta de trapaça e do relatório). */
  priceBefore: number;
  /** Um dos lados é a casa. */
  withHouse: boolean;
  /** O negócio já foi anulado por um caso de trapaça. */
  annulled: boolean;
  buyerWalletId: number;
  sellerWalletId: number;
}

type Db = Database | DrizzleTx;

/** Do mais recente para o mais antigo, com desempate pelo id (dois negócios no mesmo instante não se repetem nem somem). */
export async function auditTrades(db: Db, f: AuditTradesFilter): Promise<AuditTradeRow[]> {
  const filters: SQL[] = [eq(trades.seasonId, f.seasonId)];
  if (f.wallet !== undefined) filters.push(or(eq(trades.buyerWalletId, f.wallet), eq(trades.sellerWalletId, f.wallet))!);
  if (f.pair) {
    const [a, b] = f.pair;
    filters.push(
      or(
        and(eq(trades.buyerWalletId, a), eq(trades.sellerWalletId, b)),
        and(eq(trades.buyerWalletId, b), eq(trades.sellerWalletId, a)),
      )!,
    );
  }
  if (f.ticker) filters.push(eq(clubs.ticker, f.ticker));
  if (f.from) filters.push(gte(trades.at, f.from));
  if (f.to) filters.push(lt(trades.at, f.to));
  if (f.after) filters.push(sql`(${trades.at}, ${trades.id}) < (${f.after.at.toISOString()}::timestamptz, ${f.after.id})`);
  const rows = await db
    .select({
      id: trades.id,
      at: trades.at,
      clubId: trades.clubId,
      ticker: sql<string>`${clubs.ticker}`,
      quantity: trades.quantity,
      price: trades.price,
      inAuction: trades.inAuction,
      priceBefore: trades.priceBefore,
      withHouse: trades.withHouse,
      annulled: sql<boolean>`exists (select 1 from futbolsa.trade_annulments ta where ta.trade_id = ${trades.id})`,
      buyerWalletId: trades.buyerWalletId,
      sellerWalletId: trades.sellerWalletId,
    })
    .from(trades)
    .innerJoin(clubs, eq(clubs.id, trades.clubId))
    .where(and(...filters))
    .orderBy(desc(trades.at), desc(trades.id))
    .limit(f.limit);
  return rows;
}
