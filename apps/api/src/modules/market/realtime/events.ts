import { Injectable } from "@nestjs/common";
import {
  bookEventSchema,
  candleEventSchema,
  clubChannel,
  matchModeEventSchema,
  orderUpdatedEventSchema,
  priceEventSchema,
  seasonStatusEventSchema,
  tradeEventSchema,
  type SeasonStatusEvent,
} from "@futbolsa/contracts";
import { inArray } from "drizzle-orm";
import type { Tx } from "../../../infra/db/index.js";
import { wallets } from "../../../infra/db/schema/index.js";
import { EventBus, meChannel } from "../../../infra/realtime/index.js";
import { PortfolioLedger } from "../../portfolio/portfolio.module.js";
import { WalletEvents } from "../../portfolio/wallet-events.js";
import type { CandleRecord } from "../../portfolio/candles/record-trade.js";
import type { PostResult } from "../../portfolio/ledger/post.js";
import type { AuctionClosed } from "../auction/close-auction.js";
import type { OrderRecord, PlaceOrderAccepted, TradeRecord } from "../matching/matching-engine.js";
import { BookPublisher } from "./book-publisher.js";

/** As colunas da temporada que o `season.status` leva. */
export interface SeasonStatusRow {
  id: number;
  status: string;
  ipoClosesAt: Date | null;
  tradingOpensAt: Date | null;
}

/**
 * Os eventos de tempo real do mercado (T7), sempre depois do `COMMIT` (`tx.afterCommit`): o cliente que reage ao
 * evento lê o banco, e uma transação desfeita não avisa ninguém.
 * - canal do clube: `trade` (com o `id`, sem comprador nem vendedor), `candle` (o candle de 15 minutos e o do dia que o
 *   negócio atualizou) e, pelo `BookPublisher` (P3), `book`; `price` no canal `prices`;
 * - canal `me`, só do dono: `order.updated` de cada ordem que mudou, e `wallet.changed` e `entry.added` de cada
 *   carteira mexida (com a `version` da carteira). Carteira de bot ou da tesouraria não publica.
 *
 * Quem chama: a ordem nova (`afterPlace`), o fim do leilão (`afterAuction`, L5) e o cancelamento (`ordersChanged`).
 */
@Injectable()
export class MarketEvents {
  constructor(
    private readonly bus: EventBus,
    private readonly ledger: PortfolioLedger,
    private readonly wallets: WalletEvents,
    readonly book: BookPublisher,
  ) {
    bus.registerSchema("trade", tradeEventSchema);
    bus.registerSchema("book", bookEventSchema);
    bus.registerSchema("match_mode", matchModeEventSchema);
    bus.registerSchema("candle", candleEventSchema);
    bus.registerSchema("price", priceEventSchema);
    bus.registerSchema("order.updated", orderUpdatedEventSchema);
    bus.registerSchema("season.status", seasonStatusEventSchema);
  }

  /**
   * Uma ordem nova que foi aceita, dentro da transação dela: grava os candles de cada negócio e agenda tudo o que sai
   * depois do `COMMIT`. Só mexe no banco para os candles; o resto é aviso.
   */
  async afterPlace(tx: Tx, r: PlaceOrderAccepted): Promise<void> {
    const candles: CandleRecord[] = [];
    for (const t of r.trades) candles.push(...(await this.ledger.recordTrade(tx, { clubId: r.club.clubId, at: t.at, price: t.price, quantity: t.quantity })));
    // a ordem nova e as ordens do livro que andaram, uma vez cada (a ordem nova pode estar nas duas listas)
    const changed = new Map<number, OrderRecord>();
    for (const o of [...r.bookOrders, r.order]) changed.set(o.id, o);
    await this.tradesDone(tx, r.club.ticker, r.trades, candles, [...changed.values()], r.posts);
  }

  /**
   * O fim de um leilão (`CloseAuctionService`, L5), dentro da transação dele: os candles já foram gravados lá, um
   * por negócio, e aqui só se agenda o que sai depois do `COMMIT` com as mesmas peças da ordem nova: `trade` de cada
   * negócio e os candles como ficaram; `order.updated` das ordens que andaram e `wallet.changed`/`entry.added` de
   * cada linha do extrato, só para os donos; e o clube marcado para republicar `book` e `price`, que levam o fim do
   * leilão (P11). Sem negócio, só o clube marcado.
   */
  async afterAuction(tx: Tx, r: AuctionClosed): Promise<void> {
    await this.tradesDone(tx, r.ticker, r.trades, r.candles, r.orders, r.posts);
  }

  /** O que sai de negócios gravados (da ordem nova ou do leilão), depois do `COMMIT`. */
  private async tradesDone(
    tx: Tx,
    ticker: string,
    trades: readonly TradeRecord[],
    candles: readonly CandleRecord[],
    orders: readonly OrderRecord[],
    posts: readonly PostResult[],
  ): Promise<void> {
    for (const post of posts) await this.wallets.posted(tx, post, post.entry.clubId === null ? undefined : ticker);
    const owners = await this.ownersFor(tx, orders, posts);
    tx.afterCommit(() => {
      const channel = clubChannel(ticker);
      for (const t of trades) this.bus.publish(channel, "trade", { id: t.id, at: t.at.toISOString(), price: t.price, quantity: t.quantity });
      for (const c of candles) {
        this.bus.publish(channel, "candle", {
          interval: c.interval,
          start: c.start.toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          turnover: c.turnover,
        });
      }
      for (const o of orders) this.publishOrder(owners.get(o.walletId), o);
    });
    this.book.markClubDirty(tx, ticker);
  }

  /**
   * Ordens que mudaram sem negócio (cancelamento, bloqueio, exclusão, suspensão, fim da negociação), com as
   * movimentações das carteiras que devolveram a reserva: avisa os donos e marca o clube para o livro.
   */
  async ordersChanged(tx: Tx, ticker: string, orders: readonly OrderRecord[], posts: readonly PostResult[]): Promise<void> {
    for (const post of posts) await this.wallets.posted(tx, post, post.entry.clubId === null ? undefined : ticker);
    const owners = await this.ownersFor(tx, orders, posts);
    tx.afterCommit(() => {
      for (const o of orders) this.publishOrder(owners.get(o.walletId), o);
    });
    this.book.markClubDirty(tx, ticker);
  }

  /**
   * A temporada mudou de estado (o fim da negociação, T14), no canal `season`, com o mesmo esquema que o IPO usa
   * (`seasonStatusEventSchema`): as datas são as da linha já gravada.
   */
  seasonStatus(tx: Tx, season: SeasonStatusRow): void {
    const data = {
      seasonId: season.id,
      status: season.status as SeasonStatusEvent["status"],
      ipoClosesAt: season.ipoClosesAt?.toISOString() ?? null,
      tradingOpensAt: season.tradingOpensAt?.toISOString() ?? null,
    };
    tx.afterCommit(() => this.bus.publish("season", "season.status", data));
  }

  /** O modo de jogo do clube ligou ou desligou (valor absoluto, seguro de repetir). */
  matchMode(tx: Tx, ticker: string, active: boolean): void {
    tx.afterCommit(() => this.bus.publish(clubChannel(ticker), "match_mode", { active }));
  }

  private ownersOf(posts: readonly PostResult[]): Map<number, string | null> {
    return new Map(posts.map((p) => [p.wallet.id, p.wallet.userId]));
  }

  /**
   * Quem é dono de cada ordem que mudou. Sai das linhas do extrato; a ordem que mudou sem nenhuma linha (a compra a
   * mercado cancelada inteira, que não reserva nada) não tem carteira nos `posts`: o dono vem da própria carteira, para
   * a outra aba dele ver a ordem cancelada (achado da revisão T17).
   */
  private async ownersFor(tx: Tx, orders: readonly OrderRecord[], posts: readonly PostResult[]): Promise<Map<number, string | null>> {
    const owners = this.ownersOf(posts);
    const missing = [...new Set(orders.map((o) => o.walletId))].filter((id) => !owners.has(id));
    if (missing.length > 0) {
      const rows = await tx.db.select({ id: wallets.id, userId: wallets.userId }).from(wallets).where(inArray(wallets.id, missing));
      for (const row of rows) owners.set(row.id, row.userId);
    }
    return owners;
  }

  private publishOrder(userId: string | null | undefined, o: OrderRecord): void {
    if (!userId) return;
    this.bus.publish(meChannel(userId), "order.updated", {
      id: o.id,
      ticker: o.ticker,
      side: o.side,
      type: o.type,
      quantity: o.quantity,
      filled: o.filled,
      limitPrice: o.limitPrice,
      reservedCash: o.reservedCash,
      status: o.status,
      cancelReason: o.cancelReason,
    });
  }
}
