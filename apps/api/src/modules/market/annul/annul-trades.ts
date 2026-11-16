import { Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { FRAUD_ERROR_MESSAGES } from "@futbolsa/contracts";
import type { Cents } from "@futbolsa/engine";
import { type LockedClub, lockClubs, type Tx } from "../../../infra/db/index.js";
import { clubs, seasonClubs, tradeAnnulments, trades } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { rebuildCandles } from "../../portfolio/candles/rebuild.js";
import { RefreshService } from "../maker/refresh.service.js";
import { instantOf } from "../matching/postgres-matching-engine.js";
import { displayedPriceOf, lastTradeUntil } from "../state/displayed-price.js";
import { rebuildTunnelReference } from "../state/tunnel-state.js";

/** Um negócio a anular, com o que o `planAnnulment` do motor calculou para ele (o que volta e o que faltou). */
export interface AnnulledTrade {
  tradeId: number;
  /** Ações que o comprador devolve ao vendedor. */
  sharesReturned: number;
  /** Dinheiro que o vendedor devolve ao comprador (o das ações que voltaram). */
  cashReturned: Cents;
  /** Ações que o comprador já não tinha: ficam como estão, e o dinheiro delas fica com quem vendeu. */
  sharesShort: number;
}

export interface AnnulTradesInput {
  seasonId: number;
  /** O caso de trapaça que anula (`fraud_cases.id`, do `admin`). */
  caseId: number;
  /** O instante da anulação: a referência do túnel é refeita para o dia dele. */
  at: Date;
  trades: readonly AnnulledTrade[];
}

/** O que mudou em cada clube, para quem chama avisar depois do `COMMIT` (`markClubDirty`, `history_changed`). */
export interface AnnulledClub {
  clubId: number;
  ticker: string;
  /** O preço exibido de agora, sem os anulados (o último negócio que sobrou ou o preço do IPO). */
  price: Cents;
  lastTradeAt: Date | null;
  /** A referência do túnel refeita. */
  tunnelRef: Cents;
  /** O horário do negócio anulado mais antigo do clube: os candles foram refeitos desde o período dele. */
  since: Date;
}

export interface AnnulTradesResult {
  /** Em ordem de ticker. */
  clubs: AnnulledClub[];
  /** O horário do negócio anulado mais antigo de todos (o `from` do pedido de recálculo dos rankings). */
  since: Date;
}

/** Negócio que não existe na temporada, repetido no pedido ou já anulado: `trade_not_annullable` (409). */
export function tradeNotAnnullable(): DomainError {
  return new DomainError("trade_not_annullable", 409, FRAUD_ERROR_MESSAGES.trade_not_annullable);
}

/**
 * Tira negócios do preço por trapaça (Admin, critério 42; Plano do admin de jogadores e bots, proposta 16 e
 * "Decidir", passo 7). `trades` não se edita: o negócio anulado ganha uma linha em `trade_annulments`, e todas as
 * leituras do preço (`lastTradeUntil`, `displayedPrice(s)`), os últimos negócios do livro e os candles passam a
 * ignorá-lo. Dentro da transação de quem chama, que já travou os clubes dos negócios (`lockClubs`) e as carteiras, e
 * já moveu o dinheiro e as ações (`portfolio.post` com `trade_annulled`). Para cada clube:
 *
 * 1. `last_price` e `last_trade_at` voltam ao último negócio não anulado; sem nenhum, ao preço do IPO, sem horário;
 * 2. os candles são refeitos desde o período do negócio anulado mais antigo do clube (`rebuildCandles` do `portfolio`);
 * 3. a referência do túnel é refeita para o dia de `at` (`rebuildTunnelReference`: o último leilão de hoje não
 *    anulado ou, sem ele, o preço exibido às 0h sem os anulados);
 *
 * e no fim pede a reposição da casa nos clubes, com o motivo `correction` (a cotação dela partia do preço velho).
 *
 * Recusa com `trade_not_annullable` o negócio que não é da temporada, repetido ou já anulado (um negócio só se anula
 * uma vez). A recusa `club_in_auction` é de quem chama, com `isInAuction` sobre a linha que o `lockClubs` devolveu:
 * aqui um clube em leilão é erro de programação (a referência do túnel não muda até o leilão acabar). Os avisos depois
 * do `COMMIT` também são de quem chama, com o que a função devolve.
 */
export async function annulTrades(
  tx: Tx,
  input: AnnulTradesInput,
  refresh: Pick<RefreshService, "requestRefresh">,
): Promise<AnnulTradesResult> {
  const ids = input.trades.map((t) => t.tradeId);
  if (ids.length === 0) throw new Error("anulação sem negócio");
  if (new Set(ids).size !== ids.length) throw tradeNotAnnullable();

  // Os negócios, com o clube e se já foram anulados. Com os clubes travados, uma anulação dos mesmos negócios que
  // terminou antes já aparece aqui; a chave primária de `trade_annulments` segura o resto.
  const rows = await tx.db
    .select({ id: trades.id, at: trades.at, ticker: sql<string>`${clubs.ticker}`, annulled: tradeAnnulments.tradeId })
    .from(trades)
    .innerJoin(clubs, eq(clubs.id, trades.clubId))
    .leftJoin(tradeAnnulments, eq(tradeAnnulments.tradeId, trades.id))
    .where(and(inArray(trades.id, ids), eq(trades.seasonId, input.seasonId)));
  if (rows.length !== ids.length || rows.some((r) => r.annulled !== null)) throw tradeNotAnnullable();

  const sinceOf = new Map<string, Date>();
  for (const r of rows) {
    const known = sinceOf.get(r.ticker);
    if (!known || r.at.getTime() < known.getTime()) sinceOf.set(r.ticker, r.at);
  }
  const tickers = [...sinceOf.keys()].sort();
  for (const ticker of tickers) {
    if (!tx.locks.isClubLocked(ticker)) throw new Error(`o clube ${ticker} não está travado nesta transação`);
  }

  const inserted = await tx.db
    .insert(tradeAnnulments)
    .values(
      input.trades.map((t) => ({
        tradeId: t.tradeId,
        caseId: input.caseId,
        at: input.at,
        sharesReturned: t.sharesReturned,
        cashReturned: t.cashReturned,
        sharesShort: t.sharesShort,
      })),
    )
    .onConflictDoNothing()
    .returning({ tradeId: tradeAnnulments.tradeId });
  if (inserted.length !== ids.length) throw tradeNotAnnullable();

  // Os clubes já estão travados por quem chama: aqui só se relê a linha na mesma trava.
  const locked = await lockClubs(tx, input.seasonId, tickers);
  const out: AnnulledClub[] = [];
  for (const club of locked) {
    const since = sinceOf.get(club.ticker)!;
    const rebuilt = await rebuildPrice(tx, club, input.at);
    await rebuildCandles(tx, club.clubId, since);
    const tunnelRef = await rebuildTunnelReference(tx, rebuilt, input.at);
    out.push({ clubId: club.clubId, ticker: club.ticker, price: rebuilt.lastPrice!, lastTradeAt: rebuilt.lastTradeAt, tunnelRef, since });
  }
  await refresh.requestRefresh(tx, tickers, "correction", { seasonId: input.seasonId, at: input.at });
  const since = new Date(Math.min(...out.map((c) => c.since.getTime())));
  return { clubs: out, since };
}

/**
 * `last_price` e `last_trade_at` do clube travado voltam ao último negócio não anulado (até a anulação ou o último
 * horário que o clube já teve, o que for depois: o horário dos negócios de um clube nunca recua, `instantOf`); sem
 * nenhum, ao preço do IPO, como a liquidação do IPO deixa (`last_trade_at` vazio). Devolve a linha com as colunas novas.
 */
async function rebuildPrice(tx: Tx, club: LockedClub, at: Date): Promise<LockedClub> {
  const last = await lastTradeUntil(tx.db, club.clubId, instantOf(at, club.lastTradeAt));
  const lastPrice = last?.price ?? displayedPriceOf({ lastPrice: null, ipoPrice: club.ipoPrice ?? club.lastPrice });
  const lastTradeAt = last?.at ?? null;
  await tx.db
    .update(seasonClubs)
    .set({ lastPrice, lastTradeAt, referencePrice: null })
    .where(and(eq(seasonClubs.seasonId, club.seasonId), eq(seasonClubs.clubId, club.clubId)));
  return { ...club, lastPrice, lastTradeAt, referencePrice: null };
}

/**
 * `annulTrades` como o Nest o injeta, com o `RefreshService` do módulo para o pedido de reposição. É o que a decisão
 * do caso de trapaça (T25, `admin/fraud/decision.service.ts`) recebe.
 */
@Injectable()
export class TradeAnnulService {
  constructor(private readonly refresh: RefreshService) {}

  annulTrades(tx: Tx, input: AnnulTradesInput): Promise<AnnulTradesResult> {
    return annulTrades(tx, input, this.refresh);
  }
}
