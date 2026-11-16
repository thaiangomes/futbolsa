import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { dayStart, nextReference, type Cents, type Quote } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockWallets, type TransactionOptions, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, marketRefreshRequests, seasonClubs, seasons } from "../../../infra/db/schema/index.js";
import type { RefreshReason } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { readOppositeSide, type BookCursor } from "../book/book-repo.js";
import {
  isAuctionExpired,
  type AuctionExpired,
  type OrderRecord,
  type PlaceOrderAccepted,
  type TradeRecord,
} from "../matching/matching-engine.js";
import { instantOf } from "../matching/postgres-matching-engine.js";
import { CancelService } from "../orders/cancel.service.js";
import { OrderService } from "../orders/order.service.js";
import { MarketEvents } from "../realtime/events.js";
import { displayedPriceOf, referencePriceOf } from "../state/displayed-price.js";
import { tradingGate } from "../state/gate.js";
import { inMatch } from "../state/match-mode.js";
import { AuctionCloser, auctionExpired, auctionOf, isInAuction } from "../state/tunnel-state.js";
import { FairValueService } from "./fair-value.service.js";
import { houseQuote, houseQuoteSize, quotePrices, quoteReference, readTreasuryFunds, treasuryWalletId } from "./quote-input.js";

/** Por que a reposição não cotou: a negociação não está aberta, ou o clube ou o mercado estão suspensos. */
export type RefreshSkipReason = "market_closed" | "club_suspended";

export interface RefreshSkipped {
  refreshed: false;
  reason: RefreshSkipReason;
  seasonId: number;
  ticker: string;
}

/** A reposição feita: as cotações velhas canceladas e as novas no livro (ou executadas, P2). */
export interface ClubRefreshed {
  refreshed: true;
  seasonId: number;
  ticker: string;
  clubId: number;
  /** O instante das ordens e do extrato da reposição: o `now` de quem chamou, nunca antes do último negócio do clube. */
  at: Date;
  /** O valor justo usado (antes do piso de R$ 0,50 da âncora). */
  fairValue: Cents;
  inMatch: boolean;
  /** A quantidade máxima por lado (`quoteSize` com os valores de `seasons`). */
  size: number;
  /** A cotação calculada com o que a tesouraria tinha livre; um lado ausente não foi cotado (critério 29). */
  quote: Quote;
  /** As cotações velhas da casa no clube, canceladas com `house_refresh`. */
  cancelled: OrderRecord[];
  /** O lado da compra e o da venda como o motor de ordens os aceitou; nulo quando o lado não foi cotado. */
  bid: PlaceOrderAccepted | null;
  ask: PlaceOrderAccepted | null;
  /** Os negócios que a cotação nova fez contra ordens que ela cruzou (P2), na ordem em que saíram. */
  trades: TradeRecord[];
  /** Uma das cotações sairia do túnel de preço: o clube entrou em leilão e ela ficou inteira no livro (D2). */
  openedAuction: boolean;
  /** O leilão do clube depois da reposição (nulo fora de leilão). */
  auction: { until: Date | null } | null;
  /** O leilão vencido foi fechado antes da reposição (P10). */
  closedAuction: boolean;
  /** Os pedidos de `market_refresh_requests` atendidos por esta reposição. */
  requestsDone: number;
}

export type RefreshResult = ClubRefreshed | RefreshSkipped;

/** Os pontos de pausa dos testes de concorrência e os atalhos da tarefa de cada minuto. Sem eles, nada muda. */
export interface RefreshOptions {
  /**
   * Os valores justos já calculados, por ticker (a tarefa calcula uma vez para todos os clubes). Sem eles, a
   * reposição calcula pelo `FairValueService`, fora da transação.
   */
  fairValues?: ReadonlyMap<string, Cents>;
  /** O modo de jogo do clube já lido (a tarefa lê todos de uma vez com `clubsInMatch`). */
  inMatch?: boolean;
  /** Dentro da transação, antes da trava do clube. */
  beforeClubLock?: () => Promise<void>;
  /** Com o clube travado, antes de ler a temporada. */
  afterClubLock?: () => Promise<void>;
  /** Com os preços e as contrapartes calculados, antes de travar as carteiras. */
  beforeWalletLock?: () => Promise<void>;
  /** Repassado ao `withTransaction` (`onRetry` conta as repetições por *deadlock*). */
  transaction?: TransactionOptions;
}

/** O que o `requestRefresh` pede, para quem acorda a reposição. */
export interface RefreshWakeUp {
  seasonId: number;
  /** Em ordem de ticker, sem repetição. */
  tickers: string[];
  reason: RefreshReason;
}

export type RefreshWakeListener = (request: RefreshWakeUp) => void | Promise<void>;

/**
 * Quem acorda a reposição na hora depois de um pedido (P5 do plano): o `requestRefresh` chama `wake` no `afterCommit`
 * da transação que gravou o pedido, sem esperar a tarefa de cada minuto (critério 32: na retomada da suspensão, a
 * casa cota "na mesma hora"). A tarefa da agenda (T11) se inscreve com `onWake` na subida e repõe os clubes pedidos;
 * sem ninguém inscrito, o pedido fica gravado e a tarefa de cada minuto o atende. É um ponto de inscrição, e não uma
 * classe que a tarefa implementa, para a tarefa depender do `RefreshService` sem o Nest ver um círculo.
 *
 * O erro de um inscrito não afeta os outros nem quem pediu (o pedido já foi gravado).
 */
@Injectable()
export class RefreshWaker {
  private readonly logger = new Logger(RefreshWaker.name);
  private readonly listeners: RefreshWakeListener[] = [];

  /** Inscreve quem repõe os clubes pedidos; devolve a função que desfaz a inscrição. */
  onWake(listener: RefreshWakeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  async wake(request: RefreshWakeUp): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        await listener(request);
      } catch (error) {
        this.logger.error(`falha ao acordar a reposição de ${request.tickers.join(", ")}: ${(error as Error).message}`);
      }
    }
  }
}

/** A reposição achou o leilão do clube vencido: nada foi gravado, e o leilão fecha antes (P10). */
class AuctionExpiredRollback extends Error {
  constructor(readonly expired: Pick<AuctionExpired, "seasonId" | "ticker" | "until">) {
    super(`o leilão de ${expired.ticker} venceu às ${expired.until.toISOString()}: fecha antes de repor`);
    this.name = "AuctionExpiredRollback";
  }
}

/**
 * A reposição da casa num clube (Livro de ofertas e formador de mercado, "Cotação do formador de mercado"; Plano do
 * livro de ofertas e formador, "Reposição da casa, passo a passo", T10, e "Túnel e leilão", L6). A casa cancela as
 * cotações do clube e coloca novas, com o caixa e as ações da tesouraria; o que foi executado entre duas reposições
 * não volta antes da seguinte (quem decide **quando** repor é a agenda, T11).
 *
 * Fora da transação: os pedidos abertos do clube, o valor justo (T9) e o modo de jogo. Depois, uma transação:
 *
 * 1. trava o clube e lê a temporada depois da trava. Mercado fechado, clube ou mercado suspenso: não cota, e os
 *    pedidos continuam abertos até a retomada pedir outra reposição. Leilão vencido: sai sem gravar nada, fecha o
 *    leilão numa transação própria (`AuctionCloser`) e repete uma vez (P10);
 * 2. lê sem trava a tesouraria. Os **preços** novos dependem só do valor justo, do modo de jogo e do preço exibido;
 *    a quantidade máxima é a de `quoteSize` com os valores de `seasons`;
 * 3. fora de leilão, as contrapartes possíveis: os donos das ordens (de jogadores e bots) que a cotação nova
 *    cruzaria, pelo preço e até a quantidade máxima, sem cortar pelo caixa (P1). Em leilão, nenhuma: nada executa;
 * 4. trava as contrapartes e a tesouraria numa chamada só (`lockWallets`, a tesouraria por último);
 * 5. cancela as cotações velhas da casa no clube (`house_refresh`), devolvendo as reservas da tesouraria;
 * 6. relê a tesouraria, já travada, e calcula a cotação de verdade com o caixa livre e as ações livres dela;
 * 7. coloca a compra e depois a venda pelo caminho da casa no motor de ordens (sem a faixa de 20% nem o limite de
 *    50 ordens). O que cruzar executa (P2), com `with_house`, e muda o preço exibido; a casa nunca fica com o livro
 *    cruzado. Em leilão a cotação entra sem casar; fora dele, a que sairia do túnel abre o leilão e entra nele (D2);
 * 8. grava `mm_refreshed_at` e marca como atendidos os pedidos lidos no começo;
 * 9. depois do `COMMIT`: `match_mode` com o valor atual (absoluto, seguro de repetir), o clube sujo para `book` e
 *    `price`, e os eventos dos negócios (estes pelo `OrderService`).
 *
 * As travas seguem a ordem do jogo: o clube, depois as carteiras por id e a tesouraria por último. Por isso a
 * reposição de dois clubes ao mesmo tempo, que trava a tesouraria nos dois, e a reposição durante um negócio na
 * mesma tesouraria nunca esperam uma pela outra em círculo. O motor de ordens trava de novo o clube e as carteiras
 * que a cotação alcança: todas já estão travadas pelo passo 4, então nenhuma trava sai fora da ordem.
 */
@Injectable()
export class RefreshService {
  /** Ordens lidas por vez do livro, na procura das contrapartes. */
  pageSize = 200;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly orders: OrderService,
    private readonly cancels: CancelService,
    /** O valor justo (T9). O tipo aceita qualquer objeto com `compute`, para os testes. */
    @Inject(FairValueService) private readonly fairValues: Pick<FairValueService, "compute">,
    private readonly clock: Clock,
    /** Quem fecha o leilão vencido (L5). Opcional: sem ele, a reposição que encontra um leilão vencido é erro. */
    @Optional() private readonly auctions?: AuctionCloser,
    /** Os avisos depois do `COMMIT`. Opcional: sem ele a reposição não avisa o modo de jogo nem o livro. */
    @Optional() private readonly events?: MarketEvents,
    /** Quem acorda a reposição na hora depois de um pedido (a T11 se inscreve nele). Opcional nos testes. */
    @Optional() private readonly waker?: RefreshWaker,
  ) {}

  /**
   * Repõe a cotação da casa num clube, numa transação própria (que repete se o Postgres abortar por *deadlock*).
   * Com o leilão vencido, fecha o leilão antes e repete uma vez.
   */
  async refreshClub(seasonId: number, ticker: string, now: Date, options: RefreshOptions = {}): Promise<RefreshResult> {
    const clubId = await this.listedClubId(seasonId, ticker);
    // Os pedidos abertos são lidos ANTES do valor justo: um pedido gravado depois desta leitura (um placar que entrou
    // no meio da reposição) não é marcado como atendido, e pede outra reposição com o valor justo novo.
    const pending = await this.pendingRequestIds(seasonId, clubId);
    const fairValue = (options.fairValues ?? (await this.fairValues.compute(seasonId, now))).get(ticker);
    if (fairValue === undefined) throw new Error(`sem valor justo para ${ticker} na temporada ${seasonId}`);
    const matchMode = options.inMatch ?? (await inMatch(this.db, seasonId, clubId, now));

    let closedAuction = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await withTransaction(
          this.db,
          async (tx) => {
            if (options.beforeClubLock) await options.beforeClubLock();
            return this.refreshIn(tx, { seasonId, ticker, now, fairValue, inMatch: matchMode, pending }, options);
          },
          options.transaction,
        );
        return result.refreshed ? { ...result, closedAuction } : result;
      } catch (error) {
        if (!(error instanceof AuctionExpiredRollback)) throw error;
        if (!this.auctions) throw new Error(`o leilão de ${ticker} venceu e não há quem o feche (AuctionCloser não registrado)`);
        if (attempt > 0) throw new Error(`o leilão de ${ticker} continua vencido depois de fechado`);
        await this.auctions.closeAuction(seasonId, ticker, now);
        closedAuction = true;
      }
    }
  }

  /**
   * Pede que a casa reponha a cotação dos clubes fora dos horários (motivos `score`, `correction`, `close` e
   * `resume`), na transação de quem causou o pedido: uma linha por clube em `market_refresh_requests`, e depois do
   * `COMMIT` o `RefreshWaker` acorda a reposição na hora (P5). Se a transação desfaz, o pedido some e ninguém acorda.
   * Não trava nada: o pedido só é lido pela reposição. A temporada é a atual, se quem chama não disser outra.
   */
  async requestRefresh(
    tx: Tx,
    tickers: readonly string[],
    reason: RefreshReason,
    options: { seasonId?: number; at?: Date } = {},
  ): Promise<void> {
    const unique = [...new Set(tickers)].sort();
    if (unique.length === 0) return;
    const seasonId = options.seasonId ?? (await currentSeason(tx.db))?.id;
    if (seasonId === undefined) throw new Error("pedido de reposição sem temporada atual");
    const rows = await tx.db
      .select({ clubId: seasonClubs.clubId, ticker: clubs.ticker })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, seasonId), inArray(clubs.ticker, unique)));
    if (rows.length !== unique.length) {
      const found = new Set(rows.map((r) => r.ticker));
      throw new Error(`clube não listado na temporada ${seasonId}: ${unique.filter((t) => !found.has(t)).join(", ")}`);
    }
    const at = options.at ?? this.clock.now();
    await tx.db.insert(marketRefreshRequests).values(rows.map((r) => ({ seasonId, clubId: r.clubId, reason, requestedAt: at })));
    const waker = this.waker;
    if (waker) tx.afterCommit(() => waker.wake({ seasonId, tickers: unique, reason }));
  }

  /** Os passos 1 a 9, dentro da transação. */
  private async refreshIn(
    tx: Tx,
    r: { seasonId: number; ticker: string; now: Date; fairValue: Cents; inMatch: boolean; pending: number[] },
    options: RefreshOptions,
  ): Promise<Omit<ClubRefreshed, "closedAuction"> | RefreshSkipped> {
    const { seasonId, ticker, now } = r;

    // 1. O clube travado: o livro e o preço exibido dele não mudam mais nesta transação. A temporada é lida depois
    //    da trava: a suspensão do mercado todo e o fim da negociação travam todos os clubes.
    const club = (await lockClubs(tx, seasonId, [ticker]))[0]!;
    if (options.afterClubLock) await options.afterClubLock();
    const [season] = await tx.db
      .select({
        status: seasons.status,
        tradingOpensAt: seasons.tradingOpensAt,
        tradingEndedAt: seasons.tradingEndedAt,
        suspendedReason: seasons.suspendedReason,
        mmQuantityBp: seasons.mmQuantityBp,
        mmMatchQuantityBp: seasons.mmMatchQuantityBp,
        mmMinSideQty: seasons.mmMinSideQty,
        mmMatchMinSideQty: seasons.mmMatchMinSideQty,
      })
      .from(seasons)
      .where(eq(seasons.id, seasonId));
    if (!season) throw new Error(`temporada inexistente: ${seasonId}`);
    const at = instantOf(now, club.lastTradeAt);
    // Na suspensão o formador não cota (as cotações já saíram do livro na transação da suspensão); fora do horário
    // de negociação também não. Os pedidos ficam abertos: a retomada pede outra reposição.
    const gate = tradingGate(season, club, at);
    if (!gate.open) return { refreshed: false, reason: gate.code, seasonId, ticker };
    // A casa não cota num leilão vencido: o fim dele roda antes, numa transação própria (P10).
    if (auctionExpired(club, at)) throw new AuctionExpiredRollback({ seasonId, ticker, until: club.auctionUntil! });

    // 2. Os preços, sem caixa nem ações: só o valor justo, o modo de jogo e o preço exibido da linha travada.
    const treasury = await treasuryWalletId(tx.db, seasonId);
    const inAuction = isInAuction(club);
    const reference = quoteReference(r.fairValue);
    // A referência que decai (rodada Z): sem negócio e longe do valor justo, a faixa de 20%, o túnel e a margem da
    // casa passam a olhar um preço que anda em direção a ele. Em leilão não muda nada: o clube espera o preço único.
    if (!inAuction) {
      const decayed = nextReference({ lastPrice: displayedPriceOf(club), lastTradeAt: club.lastTradeAt?.getTime() ?? null, fair: reference, now: at.getTime() });
      if (decayed !== club.referencePrice) {
        // o túnel acompanha a referência (e volta ao preço exibido quando ela some): a cotação da casa não pode abrir leilão só por isso
        await tx.db
          .update(seasonClubs)
          .set({ referencePrice: decayed, tunnelRef: decayed ?? displayedPriceOf(club), tunnelRefDay: new Date(dayStart(at.getTime())) })
          .where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club.clubId)));
        club.referencePrice = decayed;
        club.tunnelRef = decayed ?? displayedPriceOf(club);
        club.tunnelRefDay = new Date(dayStart(at.getTime()));
      }
    }
    const displayedPrice = referencePriceOf(club);
    const size = houseQuoteSize(season, club.totalShares, r.inMatch);
    const prices = quotePrices(reference, r.inMatch, displayedPrice);

    // 3 e 4. As contrapartes possíveis (P1) e a tesouraria, numa trava só. Em leilão nada casa: só a tesouraria.
    const counterparties = inAuction ? [] : await this.counterparties(tx, club.clubId, treasury, prices, size);
    if (options.beforeWalletLock) await options.beforeWalletLock();
    await lockWallets(tx, [...counterparties, treasury]);

    // 5. As cotações velhas saem do livro, e a reserva delas volta para o livre da tesouraria.
    const cancelled = await this.cancels.cancelOrders(tx, treasury, { tickers: [ticker] }, "house_refresh", at);

    // 6. A cotação de verdade, com o caixa livre e as ações livres da tesouraria travada.
    const funds = await readTreasuryFunds(tx.db, treasury, club.clubId);
    const quote = houseQuote({ reference, inMatch: r.inMatch, displayedPrice, size, funds });

    // 7. A compra e depois a venda, pelo caminho da casa. O que cruzar executa (P2); a que sairia do túnel abre o
    //    leilão (D2), e a do outro lado já entra nele sem casar.
    const place = async (side: "buy" | "sell", q: { price: Cents; quantity: number }): Promise<PlaceOrderAccepted> => {
      const attempt = await this.orders.placeOrder(tx, {
        seasonId,
        ticker,
        walletId: treasury,
        actor: "house",
        side,
        type: "limit",
        quantity: q.quantity,
        limitPrice: q.price,
        now,
      });
      if (isAuctionExpired(attempt)) throw new AuctionExpiredRollback(attempt);
      if (!attempt.ok) {
        // a tesouraria foi relida travada e a conta já cortou a quantidade pelo que ela tem: recusa aqui é defeito
        throw new Error(`a cotação da casa em ${ticker} (${side} de ${q.quantity} a ${q.price}) foi recusada: ${attempt.code}`);
      }
      return attempt;
    };
    const bid = quote.bid ? await place("buy", quote.bid) : null;
    const ask = quote.ask ? await place("sell", quote.ask) : null;

    // 8. A reposição feita e os pedidos lidos no começo atendidos.
    await tx.db
      .update(seasonClubs)
      .set({ mmRefreshedAt: now })
      .where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club.clubId)));
    const done =
      r.pending.length === 0
        ? []
        : await tx.db
            .update(marketRefreshRequests)
            .set({ doneAt: at })
            .where(and(inArray(marketRefreshRequests.id, r.pending), isNull(marketRefreshRequests.doneAt)))
            .returning({ id: marketRefreshRequests.id });

    // 9. Os avisos depois do COMMIT (os dos negócios e das ordens já saíram pelo motor e pelo cancelamento).
    if (this.events) {
      this.events.matchMode(tx, ticker, r.inMatch);
      this.events.book.markClubDirty(tx, ticker);
    }

    const placed = [bid, ask].filter((p): p is PlaceOrderAccepted => p !== null);
    return {
      refreshed: true,
      seasonId,
      ticker,
      clubId: club.clubId,
      at,
      fairValue: r.fairValue,
      inMatch: r.inMatch,
      size,
      quote,
      cancelled: cancelled.orders,
      bid,
      ask,
      trades: placed.flatMap((p) => p.trades),
      openedAuction: placed.some((p) => p.openedAuction),
      auction: placed.length > 0 ? placed.at(-1)!.auction : auctionOf(club),
      requestsDone: done.length,
    };
  }

  /**
   * Os donos das ordens que a cotação nova cruzaria (P1): do lado da venda até o preço da compra nova e do lado da
   * compra até o preço da venda nova, em ordem de prioridade e até somar a quantidade máxima por lado, sem cortar
   * pelo caixa. A quantidade de verdade, cortada pelo que a tesouraria tem, nunca passa da máxima, então o motor de
   * ordens nunca alcança uma carteira fora desta lista. As cotações velhas da casa ficam de fora: saem no passo 5.
   */
  private async counterparties(
    tx: Tx,
    clubId: number,
    treasury: number,
    prices: { bid: Cents; ask: Cents },
    size: number,
  ): Promise<number[]> {
    const owners = new Set<number>();
    for (const [incomingSide, price] of [
      ["buy", prices.bid],
      ["sell", prices.ask],
    ] as const) {
      let reached = 0;
      let after: BookCursor | undefined;
      while (reached < size) {
        const page = await readOppositeSide(tx.db, { clubId, incomingSide, price, after }, this.pageSize);
        for (const order of page) {
          if (order.walletId === treasury) continue;
          owners.add(order.walletId);
          reached += order.remaining;
        }
        if (page.length < this.pageSize) break;
        after = page.at(-1);
      }
    }
    return [...owners];
  }

  /** O id do clube listado na temporada pelo ticker (sem trava: só para as leituras de fora da transação). */
  private async listedClubId(seasonId: number, ticker: string): Promise<number> {
    const [row] = await this.db
      .select({ clubId: seasonClubs.clubId })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, seasonId), eq(clubs.ticker, ticker)));
    if (!row) throw new Error(`clube não listado na temporada ${seasonId}: ${ticker}`);
    return row.clubId;
  }

  /** Os pedidos de reposição ainda abertos do clube, em ordem de id. */
  private async pendingRequestIds(seasonId: number, clubId: number): Promise<number[]> {
    const rows = await this.db
      .select({ id: marketRefreshRequests.id })
      .from(marketRefreshRequests)
      .where(and(eq(marketRefreshRequests.seasonId, seasonId), eq(marketRefreshRequests.clubId, clubId), isNull(marketRefreshRequests.doneAt)))
      .orderBy(asc(marketRefreshRequests.id));
    return rows.map((r) => r.id);
  }
}
