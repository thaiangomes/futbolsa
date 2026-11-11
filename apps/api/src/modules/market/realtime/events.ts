import { Injectable } from "@nestjs/common";
import {
  bookEventSchema,
  candleEventSchema,
  clubChannel,
  matchModeEventSchema,
  orderUpdatedEventSchema,
  priceEventSchema,
  tradeEventSchema,
} from "@futbolsa/contracts";
import type { Tx } from "../../../infra/db/index.js";
import { EventBus, meChannel } from "../../../infra/realtime/index.js";
import { PortfolioLedger } from "../../portfolio/portfolio.module.js";
import { WalletEvents } from "../../portfolio/wallet-events.js";
import type { CandleRecord } from "../../portfolio/candles/record-trade.js";
import type { PostResult } from "../../portfolio/ledger/post.js";
import type { OrderRecord, PlaceOrderAccepted } from "../matching/matching-engine.js";
import { BookPublisher } from "./book-publisher.js";

/**
 * Os eventos de tempo real do mercado (T7), sempre depois do `COMMIT` (`tx.afterCommit`): o cliente que reage ao
 * evento lê o banco, e uma transação desfeita não avisa ninguém.
 * - canal do clube: `trade` (com o `id`, sem comprador nem vendedor), `candle` (o candle de 15 minutos e o do dia que o
 *   negócio atualizou) e, pelo `BookPublisher` (P3), `book`; `price` no canal `prices`;
 * - canal `me`, só do dono: `order.updated` de cada ordem que mudou, e `wallet.changed` e `entry.added` de cada
 *   carteira mexida (com a `version` da carteira). Carteira de bot ou da tesouraria não publica.
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
  }

  /**
   * Uma ordem nova que foi aceita, dentro da transação dela: grava os candles de cada negócio e agenda tudo o que sai
   * depois do `COMMIT`. Só mexe no banco para os candles; o resto é aviso.
   */
  async afterPlace(tx: Tx, r: PlaceOrderAccepted): Promise<void> {
    const ticker = r.club.ticker;
    const candles: CandleRecord[] = [];
    for (const t of r.trades) candles.push(...(await this.ledger.recordTrade(tx, { clubId: r.club.clubId, at: t.at, price: t.price, quantity: t.quantity })));
    for (const post of r.posts) await this.wallets.posted(tx, post, post.entry.clubId === null ? undefined : ticker);
    const owners = this.ownersOf(r.posts);
    // a ordem nova e as ordens do livro que andaram, uma vez cada (a ordem nova pode estar nas duas listas)
    const changed = new Map<number, OrderRecord>();
    for (const o of [...r.bookOrders, r.order]) changed.set(o.id, o);
    tx.afterCommit(() => {
      const channel = clubChannel(ticker);
      for (const t of r.trades) this.bus.publish(channel, "trade", { id: t.id, at: t.at.toISOString(), price: t.price, quantity: t.quantity });
      for (const c of candles) {
        this.bus.publish(channel, "candle", {
          interval: c.interval,
          start: c.start.toISOString(),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        });
      }
      for (const o of changed.values()) this.publishOrder(owners.get(o.walletId), o);
    });
    this.book.markClubDirty(tx, ticker);
  }

  /**
   * Ordens que mudaram sem negócio (cancelamento, bloqueio, exclusão, suspensão, fim da negociação), com as
   * movimentações das carteiras que devolveram a reserva: avisa os donos e marca o clube para o livro.
   */
  async ordersChanged(tx: Tx, ticker: string, orders: readonly OrderRecord[], posts: readonly PostResult[]): Promise<void> {
    for (const post of posts) await this.wallets.posted(tx, post, post.entry.clubId === null ? undefined : ticker);
    const owners = this.ownersOf(posts);
    tx.afterCommit(() => {
      for (const o of orders) this.publishOrder(owners.get(o.walletId), o);
    });
    this.book.markClubDirty(tx, ticker);
  }

  /** O modo de jogo do clube ligou ou desligou (valor absoluto, seguro de repetir). */
  matchMode(tx: Tx, ticker: string, active: boolean): void {
    tx.afterCommit(() => this.bus.publish(clubChannel(ticker), "match_mode", { active }));
  }

  private ownersOf(posts: readonly PostResult[]): Map<number, string | null> {
    return new Map(posts.map((p) => [p.wallet.id, p.wallet.userId]));
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
