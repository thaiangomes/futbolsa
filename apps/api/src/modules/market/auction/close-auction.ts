import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq, lte } from "drizzle-orm";
import { clearAuction, type AuctionFill, type Cents } from "@futbolsa/engine";
import { DB, type Database, lockClubs, lockWallets, type TransactionOptions, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, seasonClubs, seasons } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../../admin/current-season.js";
import type { CandleRecord } from "../../portfolio/candles/record-trade.js";
import { PortfolioLedger } from "../../portfolio/index.js";
import type { PostResult } from "../../portfolio/ledger/index.js";
import { readOppositeSide, setClubPrice, type BookOrder } from "../book/book-repo.js";
import type { OrderRecord, TradeRecord } from "../matching/matching-engine.js";
import { instantOf } from "../matching/postgres-matching-engine.js";
import { settleTrade, type TradeSide } from "../matching/settle.js";
import { MarketEvents } from "../realtime/events.js";
import { displayedPriceOf } from "../state/displayed-price.js";
import { tradingGate } from "../state/gate.js";
import { AuctionCloser, auctionExpired, endAuction, isInAuction } from "../state/tunnel-state.js";

/**
 * Por que `closeAuction` não fez nada:
 * - `not_in_auction`: o clube não está em leilão (nunca esteve, ou outra transação já fechou este);
 * - `paused`: o leilão está parado pela suspensão (sem fim marcado, L7) e não vence;
 * - `not_expired`: o fim ainda não chegou;
 * - `club_suspended`: o clube ou o mercado está suspenso, e nada executa na suspensão (fecha na retomada);
 * - `market_closed`: a negociação acabou; quem encerra o leilão sem negócio é o fim da negociação, junto com o
 *   cancelamento das ordens (L7).
 */
export type AuctionNotClosedReason = "not_in_auction" | "paused" | "not_expired" | "club_suspended" | "market_closed";

export interface AuctionNotClosed {
  closed: false;
  reason: AuctionNotClosedReason;
  seasonId: number;
  ticker: string;
}

/** O leilão terminou: com o preço único e os negócios, ou sem negócio (critério 42). */
export interface AuctionClosed {
  closed: true;
  seasonId: number;
  ticker: string;
  clubId: number;
  /** O horário do fechamento e de todos os negócios: o `now` de quem fechou, nunca antes do último negócio do clube. */
  at: Date;
  /** O preço único; nulo quando nenhuma compra alcançou uma venda. */
  price: Cents | null;
  /** Ações negociadas (zero sem negócio). */
  volume: number;
  /** O preço exibido de antes do leilão: o `price_before` de todos os negócios dele (P12). */
  priceBefore: Cents;
  /** A referência do túnel depois do leilão: o preço único, ou a de antes sem negócio (D4). */
  tunnelRef: Cents;
  /** `no_cross` quando nenhuma compra alcançou uma venda; nulo com negócio. */
  noTrade: "no_cross" | null;
  /** Os negócios, na ordem do preço único: compras do maior limite e mais antigas contra vendas do menor e mais antigas. */
  trades: TradeRecord[];
  /** As ordens em que os negócios mexeram, como ficaram (uma vez cada, em ordem de id). */
  orders: OrderRecord[];
  /** As linhas `trade` do extrato, comprador e vendedor de cada negócio, na ordem dos negócios. */
  posts: PostResult[];
  /** As carteiras com extrato novo. */
  walletIds: number[];
  /** Os candles de 15 minutos e do dia como ficaram depois do último negócio (vazio sem negócio). */
  candles: CandleRecord[];
}

export type CloseAuctionResult = AuctionClosed | AuctionNotClosed;

/** Os pontos de pausa dos testes de concorrência e o contador de repetições. Sem eles, nada muda. */
export interface CloseAuctionOptions {
  /** Dentro da transação, antes da trava do clube. */
  beforeClubLock?: () => Promise<void>;
  /** Com o clube travado, antes de ler a temporada e o livro. */
  afterClubLock?: () => Promise<void>;
  /** Com o preço único calculado, antes de travar as carteiras dos negócios. */
  beforeWalletLock?: () => Promise<void>;
  /** Repassado ao `withTransaction` (`onRetry` conta as repetições por *deadlock*). */
  transaction?: TransactionOptions;
}

/** Um clube com o leilão vencido, para a tarefa `auction-close`. */
export interface DueAuction {
  seasonId: number;
  ticker: string;
  until: Date;
}

/**
 * O fim do leilão (Livro de ofertas e formador de mercado, "Túnel de preço e leilão", critérios 40, 42 e 44; Plano do
 * livro de ofertas e formador, "Fim do leilão, passo a passo", L5). Numa transação própria, repetível e idempotente:
 *
 * 1. trava o clube e lê a temporada depois da trava. Sem leilão, com ele parado pela suspensão ou com o fim ainda no
 *    futuro, não faz nada; com o clube ou o mercado suspenso, ou a negociação encerrada, também não (nada executa);
 * 2. lê todas as ordens abertas do clube, dos dois lados, em ordem de preço e de `id`, em páginas;
 * 3. acha o preço único (`clearAuction` do motor) com a referência do túnel da linha travada;
 * 4. **sem negócio:** limpa as colunas do leilão; a referência fica e o dia dela passa a hoje (D4);
 * 5. **com negócio:** trava de uma vez as carteiras dos negócios (a tesouraria por último) e liquida cada negócio
 *    (`settleTrade`) com `in_auction`, o preço exibido de antes do leilão em todos e `with_house` quando a casa está
 *    num lado. O comprador solta a reserva do limite e paga o preço único: a diferença volta para o livre (os R$ 50,00
 *    de Ana no critério 40). A ordem que termina sai da conta de ordens abertas; a sobra fica no livro com a reserva
 *    que já tinha e nunca fica cruzada (pela regra da maior quantidade);
 * 6. o preço exibido, o último negócio e a referência do túnel passam ao preço único, de hoje; o leilão acaba; os
 *    candles andam uma vez por negócio;
 * 7. depois do `COMMIT` (`MarketEvents.afterAuction`): `trade`, `candle`, `order.updated` e `wallet.changed` dos
 *    donos, e o clube marcado para republicar `book` e `price` (P3, P11).
 *
 * O horário dos negócios é o real do fechamento (`now`, nunca o `auction_until` no passado: P10) e nunca recua
 * (`instantOf`, o mesmo do motor de ordens). Quem chega depois do fim (ordem, cancelamento, reposição) fecha o leilão
 * por aqui antes de seguir, pelo `AuctionCloser`; a tarefa `auction-close` fecha os outros a cada 5 segundos.
 */
@Injectable()
export class CloseAuctionService {
  /** Ordens lidas por vez de cada lado do livro. */
  pageSize = 500;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: PortfolioLedger,
    /** Os avisos depois do `COMMIT`. Opcional: sem ele o fim do leilão não avisa ninguém (os candles saem do mesmo jeito). */
    @Optional() private readonly events?: MarketEvents,
  ) {}

  /** Fecha o leilão vencido do clube, numa transação própria. Leilão já fechado, ou que não venceu, não faz nada. */
  async closeAuction(seasonId: number, ticker: string, now: Date, options: CloseAuctionOptions = {}): Promise<CloseAuctionResult> {
    return withTransaction(
      this.db,
      async (tx) => {
        if (options.beforeClubLock) await options.beforeClubLock();
        return this.closeIn(tx, seasonId, ticker, now, options);
      },
      options.transaction,
    );
  }

  /**
   * Os clubes da temporada atual com o leilão vencido (`auction_until` até agora), em ordem de ticker, lidos sem trava:
   * cada um é conferido de novo com o clube travado, no `closeAuction`.
   */
  async dueAuctions(now: Date): Promise<DueAuction[]> {
    const season = await currentSeason(this.db);
    if (!season) return [];
    const rows = await this.db
      .select({ ticker: clubs.ticker, until: seasonClubs.auctionUntil })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, season.id), lte(seasonClubs.auctionUntil, now)))
      .orderBy(asc(clubs.ticker));
    return rows.map((r) => ({ seasonId: season.id, ticker: r.ticker, until: r.until! }));
  }

  private async closeIn(tx: Tx, seasonId: number, ticker: string, now: Date, options: CloseAuctionOptions): Promise<CloseAuctionResult> {
    // 1. O clube travado: o livro dele não muda mais nesta transação. A temporada é lida depois da trava, como na
    //    ordem nova: a suspensão do mercado todo e o fim da negociação travam todos os clubes.
    const club = (await lockClubs(tx, seasonId, [ticker]))[0]!;
    if (options.afterClubLock) await options.afterClubLock();
    const skip = (reason: AuctionNotClosedReason): AuctionNotClosed => ({ closed: false, reason, seasonId, ticker });
    const at = instantOf(now, club.lastTradeAt);
    if (!isInAuction(club)) return skip("not_in_auction");
    if (club.auctionUntil === null) return skip("paused");
    if (!auctionExpired(club, at)) return skip("not_expired");

    const [season] = await tx.db
      .select({
        status: seasons.status,
        tradingOpensAt: seasons.tradingOpensAt,
        tradingEndedAt: seasons.tradingEndedAt,
        suspendedReason: seasons.suspendedReason,
      })
      .from(seasons)
      .where(eq(seasons.id, seasonId));
    if (!season) throw new Error(`temporada inexistente: ${seasonId}`);
    const gate = tradingGate(season, club, at);
    if (!gate.open) return skip(gate.code);

    // 2 e 3. O livro inteiro do clube e o preço único. A referência é a da linha travada (no leilão ela não vira).
    const priceBefore = displayedPriceOf(club);
    const reference = club.tunnelRef ?? priceBefore;
    const book = [...(await this.readSide(tx, club.clubId, "buy")), ...(await this.readSide(tx, club.clubId, "sell"))];
    const auction = clearAuction(
      book.map((o) => ({ id: o.id, accountId: String(o.walletId), side: o.side, limitPrice: o.limitPrice, remaining: o.remaining })),
      reference,
    );
    const base = { closed: true as const, seasonId, ticker, clubId: club.clubId, at, priceBefore };

    // 4. Sem negócio: nada muda além do fim do leilão (critério 42), e a referência de antes vale até as 0h seguintes (D4).
    if (auction.price === null) {
      const result: AuctionClosed = {
        ...base,
        price: null,
        volume: 0,
        tunnelRef: await endAuction(tx, club, reference, at),
        noTrade: "no_cross",
        trades: [],
        orders: [],
        posts: [],
        walletIds: [],
        candles: [],
      };
      await this.events?.afterAuction(tx, result);
      return result;
    }

    // 5. As carteiras de todos os negócios numa trava só, em ordem de id e com a tesouraria por último.
    if (options.beforeWalletLock) await options.beforeWalletLock();
    const byId = new Map(book.map((o) => [o.id, o]));
    const locked = await lockWallets(tx, auction.fills.flatMap((f) => [Number(f.buyerId), Number(f.sellerId)]));
    const house = new Set(locked.filter((w) => w.ownerType === "treasury").map((w) => w.id));

    const trades: TradeRecord[] = [];
    const posts: PostResult[] = [];
    const changed = new Map<number, OrderRecord>();
    for (const fill of auction.fills) {
      const buy = sideOf(byId, fill.buyOrderId, fill);
      const sell = sideOf(byId, fill.sellOrderId, fill);
      if (buy.walletId === sell.walletId) {
        throw new Error(`o leilão de ${ticker} casou a carteira ${buy.walletId} com ela mesma (ordens ${buy.orderId} e ${sell.orderId})`);
      }
      const settled = await settleTrade(tx, this.ledger, {
        seasonId,
        clubId: club.clubId,
        ticker,
        at,
        price: fill.price,
        quantity: fill.quantity,
        buy,
        sell,
        withHouse: house.has(buy.walletId) || house.has(sell.walletId),
        priceBefore,
        inAuction: true,
      });
      trades.push(settled.trade);
      posts.push(...settled.posts);
      for (const o of settled.bookOrders) changed.set(o.id, o);
    }

    // 6. O preço exibido e a referência passam ao preço único, o leilão acaba, e os candles andam a cada negócio.
    await setClubPrice(tx, seasonId, club.clubId, auction.price, at);
    const tunnelRef = await endAuction(tx, club, auction.price, at);
    const candles = new Map<string, CandleRecord>();
    for (const t of trades) {
      for (const c of await this.ledger.recordTrade(tx, { clubId: club.clubId, at: t.at, price: t.price, quantity: t.quantity })) candles.set(c.interval, c);
    }

    const result: AuctionClosed = {
      ...base,
      price: auction.price,
      volume: auction.volume,
      tunnelRef,
      noTrade: null,
      trades,
      orders: [...changed.values()].sort((a, b) => a.id - b.id),
      posts,
      walletIds: [...new Set(posts.map((p) => p.wallet.id))],
      candles: [...candles.values()],
    };
    // 7. Os avisos saem depois do COMMIT.
    await this.events?.afterAuction(tx, result);
    return result;
  }

  /** Um lado inteiro do livro em ordem de prioridade (preço, depois chegada), em páginas. */
  private async readSide(tx: Tx, clubId: number, side: "buy" | "sell"): Promise<BookOrder[]> {
    // a leitura do livro é "o outro lado" de uma ordem que chega: as compras são o outro lado de uma venda
    const incomingSide = side === "buy" ? "sell" : "buy";
    const out: BookOrder[] = [];
    for (;;) {
      const page = await readOppositeSide(tx.db, { clubId, incomingSide, after: out.at(-1) }, this.pageSize);
      out.push(...page);
      if (page.length < this.pageSize) return out;
    }
  }
}

/** Um lado de um negócio do leilão: as duas ordens já estavam no livro, e toda ordem aberta é limitada. */
function sideOf(byId: ReadonlyMap<number, BookOrder>, orderId: number, fill: AuctionFill): TradeSide {
  const order = byId.get(orderId);
  if (!order) throw new Error(`o preço único casou a ordem ${orderId}, que não foi lida do livro (${fill.buyOrderId} × ${fill.sellOrderId})`);
  return { orderId, walletId: order.walletId, type: "limit", limitPrice: order.limitPrice, resting: true };
}

/**
 * O `AuctionCloser` que o motor de ordens, o cancelamento e as rotas recebem (P10): fecha pelo `CloseAuctionService`,
 * numa transação própria, e descarta o resultado (quem chama só repete o que ia fazer).
 */
@Injectable()
export class CloseAuctionAdapter extends AuctionCloser {
  constructor(private readonly auctions: CloseAuctionService) {
    super();
  }

  async closeAuction(seasonId: number, ticker: string, now: Date): Promise<void> {
    await this.auctions.closeAuction(seasonId, ticker, now);
  }
}
