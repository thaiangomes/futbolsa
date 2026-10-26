import type { Ledger } from "./ledger.js";
import { assertCents, MIN_PRICE, type Cents } from "./money.js";

/**
 * Livro de ofertas por clube com ordens a mercado e limitadas.
 *
 * - Prioridade preço-tempo: melhor preço primeiro; no mesmo preço, a ordem
 *   mais antiga primeiro.
 * - O negócio sai pelo preço da ordem que já estava no livro.
 * - Ordem limitada de compra reserva quantidade × preço limite; de venda
 *   reserva as ações. Ordem a mercado executa o que der e o resto é cancelado
 *   (não fica no livro). Assim saldo e posição nunca ficam negativos.
 * - Uma conta não negocia com ela mesma: as próprias ordens são puladas.
 */

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface OrderRequest {
  accountId: string;
  clubId: string;
  side: Side;
  type: OrderType;
  quantity: number;
  /** Obrigatório em ordem limitada, em centavos. */
  limitPrice?: Cents;
}

export interface Order extends OrderRequest {
  id: number;
  remaining: number;
  seq: number;
  createdAt: number;
}

export interface Trade {
  clubId: string;
  price: Cents;
  quantity: number;
  buyerId: string;
  sellerId: string;
  buyOrderId: number;
  sellOrderId: number;
  /** Lado que agrediu o livro (a ordem que chegou). */
  aggressor: Side;
  at: number;
}

export type OrderStatus = "filled" | "partial" | "resting" | "cancelled" | "rejected";

export interface PlaceResult {
  status: OrderStatus;
  order?: Order;
  trades: Trade[];
  reason?: string;
}

interface Book {
  /** Ordenado por preço decrescente e, no empate, por seq crescente. */
  bids: Order[];
  /** Ordenado por preço crescente e, no empate, por seq crescente. */
  asks: Order[];
}

export interface ExchangeOptions {
  /** Contas da casa (tesouraria / formador de mercado). */
  houseAccounts?: Iterable<string>;
  /**
   * Se negócios com a casa contam para o preço exibido. O plano previa que não
   * (preço = negócios entre pessoas), mas na simulação da Fase 0 isso enviesou
   * o preço para cima: quando a tesouraria fica sem ações, a casa só compra, as
   * vendas batem nela sem mexer no preço e as compras batem em pessoas e mexem.
   * Padrão: true.
   */
  houseTradesSetPrice?: boolean;
}

export class Exchange {
  private readonly books = new Map<string, Book>();
  private readonly orders = new Map<number, Order>();
  private readonly lastTrade = new Map<string, Cents>();
  private readonly lastPeerTrade = new Map<string, Cents>();
  private readonly reference = new Map<string, Cents>();
  private readonly house: Set<string>;
  private readonly houseTradesSetPrice: boolean;
  private nextId = 1;
  private seq = 0;
  private listeners: Array<(t: Trade) => void> = [];
  /** Relógio usado nos registros; quem chama avança com `setTime`. */
  now = 0;

  constructor(
    private readonly ledger: Ledger,
    options: ExchangeOptions = {},
  ) {
    this.house = new Set(options.houseAccounts ?? []);
    this.houseTradesSetPrice = options.houseTradesSetPrice ?? true;
  }

  setTime(t: number): void {
    this.now = t;
  }

  onTrade(listener: (t: Trade) => void): void {
    this.listeners.push(listener);
  }

  /** Preço de referência inicial (o do IPO), usado até sair o 1º negócio. */
  setReferencePrice(clubId: string, price: Cents): void {
    assertCents(price, "preço de referência");
    this.reference.set(clubId, price);
  }

  /** Preço exibido: último negócio (ver houseTradesSetPrice); antes do 1º, o do IPO. */
  price(clubId: string): Cents | undefined {
    return this.lastPeerTrade.get(clubId) ?? this.reference.get(clubId);
  }

  /** Último negócio de qualquer tipo, inclusive com a casa. */
  lastTradePrice(clubId: string): Cents | undefined {
    return this.lastTrade.get(clubId);
  }

  bestBid(clubId: string): Order | undefined {
    return this.book(clubId).bids[0];
  }

  bestAsk(clubId: string): Order | undefined {
    return this.book(clubId).asks[0];
  }

  depth(clubId: string): { bids: readonly Order[]; asks: readonly Order[] } {
    const b = this.book(clubId);
    return { bids: b.bids, asks: b.asks };
  }

  openOrders(accountId: string, clubId?: string): Order[] {
    return [...this.orders.values()].filter(
      (o) => o.accountId === accountId && (clubId === undefined || o.clubId === clubId),
    );
  }

  getOrder(id: number): Order | undefined {
    return this.orders.get(id);
  }

  placeOrder(req: OrderRequest): PlaceResult {
    const rejection = this.validate(req);
    if (rejection) return { status: "rejected", trades: [], reason: rejection };

    const order: Order = {
      ...req,
      id: this.nextId++,
      remaining: req.quantity,
      seq: this.seq++,
      createdAt: this.now,
    };

    // Reserva antes de casar: na limitada de compra reserva pelo limite;
    // na venda (limitada ou a mercado) reserva as ações.
    if (req.side === "buy" && req.type === "limit") {
      this.ledger.reserveCash(req.accountId, req.quantity * req.limitPrice!);
    } else if (req.side === "sell") {
      this.ledger.reserveShares(req.accountId, req.clubId, req.quantity);
    }

    const trades = this.match(order);

    if (order.remaining === 0) return { status: "filled", order, trades };

    if (req.type === "market") {
      // Sobra de ordem a mercado não fica no livro.
      if (req.side === "sell") {
        this.ledger.releaseShares(req.accountId, req.clubId, order.remaining);
      }
      return {
        status: trades.length ? "partial" : "cancelled",
        order,
        trades,
        reason: trades.length ? undefined : "sem contraparte ou sem saldo",
      };
    }

    this.rest(order);
    return { status: trades.length ? "partial" : "resting", order, trades };
  }

  cancelOrder(id: number): boolean {
    const order = this.orders.get(id);
    if (!order) return false;
    const book = this.book(order.clubId);
    const list = order.side === "buy" ? book.bids : book.asks;
    const idx = list.indexOf(order);
    if (idx >= 0) list.splice(idx, 1);
    this.orders.delete(id);
    this.releaseRemaining(order);
    return true;
  }

  cancelAll(accountId: string, clubId?: string): number {
    const mine = this.openOrders(accountId, clubId);
    for (const o of mine) this.cancelOrder(o.id);
    return mine.length;
  }

  private validate(req: OrderRequest): string | undefined {
    if (!this.ledger.has(req.accountId)) return "conta inexistente";
    if (!Number.isInteger(req.quantity) || req.quantity <= 0) return "quantidade inválida";
    if (req.type === "limit") {
      if (req.limitPrice === undefined || !Number.isInteger(req.limitPrice)) {
        return "ordem limitada precisa de preço em centavos";
      }
      if (req.limitPrice < MIN_PRICE) return "preço abaixo do mínimo de R$ 0,50";
      if (req.side === "buy" && req.quantity * req.limitPrice > this.ledger.availableCash(req.accountId)) {
        return "saldo insuficiente";
      }
    }
    if (req.side === "sell" && req.quantity > this.ledger.availableShares(req.accountId, req.clubId)) {
      return "ações insuficientes";
    }
    return undefined;
  }

  private match(incoming: Order): Trade[] {
    const book = this.book(incoming.clubId);
    const opposite = incoming.side === "buy" ? book.asks : book.bids;
    const trades: Trade[] = [];

    let i = 0;
    while (incoming.remaining > 0 && i < opposite.length) {
      const resting = opposite[i]!;
      if (resting.accountId === incoming.accountId) {
        i++;
        continue;
      }
      const price = resting.limitPrice!;
      if (incoming.type === "limit") {
        const crosses =
          incoming.side === "buy" ? price <= incoming.limitPrice! : price >= incoming.limitPrice!;
        if (!crosses) break;
      }

      let quantity = Math.min(incoming.remaining, resting.remaining);
      if (incoming.side === "buy" && incoming.type === "market") {
        // Compra a mercado não tem reserva: limita ao dinheiro livre.
        quantity = Math.min(quantity, Math.floor(this.ledger.availableCash(incoming.accountId) / price));
        if (quantity === 0) break;
      }

      const buy = incoming.side === "buy" ? incoming : resting;
      const sell = incoming.side === "sell" ? incoming : resting;
      this.settle(buy, sell, price, quantity);

      incoming.remaining -= quantity;
      resting.remaining -= quantity;
      if (resting.remaining === 0) {
        opposite.splice(i, 1);
        this.orders.delete(resting.id);
      }

      const trade: Trade = {
        clubId: incoming.clubId,
        price,
        quantity,
        buyerId: buy.accountId,
        sellerId: sell.accountId,
        buyOrderId: buy.id,
        sellOrderId: sell.id,
        aggressor: incoming.side,
        at: this.now,
      };
      trades.push(trade);
      this.lastTrade.set(trade.clubId, price);
      const withHouse = this.house.has(trade.buyerId) || this.house.has(trade.sellerId);
      if (this.houseTradesSetPrice || !withHouse) {
        this.lastPeerTrade.set(trade.clubId, price);
      }
      for (const l of this.listeners) l(trade);
    }
    return trades;
  }

  private settle(buy: Order, sell: Order, price: Cents, quantity: number): void {
    const value = price * quantity;
    if (buy.type === "limit") this.ledger.releaseCash(buy.accountId, quantity * buy.limitPrice!);
    this.ledger.adjustCash(buy.accountId, -value);
    this.ledger.adjustShares(buy.accountId, buy.clubId, quantity);

    this.ledger.releaseShares(sell.accountId, sell.clubId, quantity);
    this.ledger.adjustShares(sell.accountId, sell.clubId, -quantity);
    this.ledger.adjustCash(sell.accountId, value);
  }

  private rest(order: Order): void {
    const book = this.book(order.clubId);
    const list = order.side === "buy" ? book.bids : book.asks;
    const better =
      order.side === "buy"
        ? (o: Order) => o.limitPrice! < order.limitPrice!
        : (o: Order) => o.limitPrice! > order.limitPrice!;
    // Entra depois de todas com preço igual ou melhor (prioridade de tempo).
    const idx = list.findIndex(better);
    if (idx === -1) list.push(order);
    else list.splice(idx, 0, order);
    this.orders.set(order.id, order);
  }

  private releaseRemaining(order: Order): void {
    if (order.remaining === 0) return;
    if (order.side === "buy" && order.type === "limit") {
      this.ledger.releaseCash(order.accountId, order.remaining * order.limitPrice!);
    } else if (order.side === "sell") {
      this.ledger.releaseShares(order.accountId, order.clubId, order.remaining);
    }
  }

  private book(clubId: string): Book {
    let b = this.books.get(clubId);
    if (!b) {
      b = { bids: [], asks: [] };
      this.books.set(clubId, b);
    }
    return b;
  }
}
