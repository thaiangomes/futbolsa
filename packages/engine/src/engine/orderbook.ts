import type { Ledger } from "./ledger.js";
import {
  entryReservation,
  matchOrder,
  remainderRelease,
  selfTradeConflict,
  settlement,
  type BalanceDelta,
  type SelfTradeMode,
} from "./matching.js";
import { assertCents, MIN_PRICE, type Cents } from "./money.js";

/**
 * Livro de ofertas por clube em memória, com ordens a mercado e limitadas. O
 * casamento é o do núcleo puro (`matching.ts`); aqui ficam o livro, as
 * reservas no `Ledger` e o preço exibido.
 *
 * - Prioridade preço-tempo: melhor preço primeiro; no mesmo preço, a ordem
 *   mais antiga primeiro.
 * - O negócio sai pelo preço da ordem que já estava no livro.
 * - Ordem limitada de compra reserva quantidade × preço limite; de venda
 *   reserva as ações. Ordem a mercado executa o que der e o resto é cancelado
 *   (não fica no livro).
 * - Ordem contra si mesmo: por padrão as próprias ordens são puladas, como na
 *   simulação calibrada; com `selfTrade: "reject"`, a ordem é recusada.
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
  /** Só na ordem a mercado: teto da compra ou piso da venda (os 20% do envio). */
  marketPriceLimit?: Cents;
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
  /** Ordem contra si mesmo: "skip" pula as próprias ordens (padrão, simulação); "reject" recusa. */
  selfTrade?: SelfTradeMode;
}

export class Exchange {
  private readonly books = new Map<string, Book>();
  private readonly orders = new Map<number, Order>();
  private readonly lastTrade = new Map<string, Cents>();
  private readonly lastPeerTrade = new Map<string, Cents>();
  private readonly reference = new Map<string, Cents>();
  private readonly house: Set<string>;
  private readonly houseTradesSetPrice: boolean;
  private readonly selfTrade: SelfTradeMode;
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
    this.selfTrade = options.selfTrade ?? "skip";
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
    this.apply(order.accountId, order.clubId, entryReservation(order));

    const book = this.book(order.clubId);
    // O livro só guarda ordens limitadas, então todas têm preço.
    const opposite = (order.side === "buy" ? book.asks : book.bids) as Array<Order & { limitPrice: Cents }>;
    const result = matchOrder(opposite, order, {
      selfTrade: this.selfTrade,
      availableCash: order.side === "buy" && order.type === "market" ? this.ledger.availableCash(order.accountId) : undefined,
      marketPriceLimit: order.type === "market" ? order.marketPriceLimit : undefined,
    });

    const trades: Trade[] = [];
    for (const fill of result.fills) {
      const resting = this.orders.get(fill.restingId)!;
      const buy = order.side === "buy" ? order : resting;
      const { buyer, seller } = settlement(fill, buy);
      this.apply(fill.buyerId, order.clubId, buyer);
      this.apply(fill.sellerId, order.clubId, seller);

      order.remaining -= fill.quantity;
      resting.remaining -= fill.quantity;
      if (resting.remaining === 0) {
        opposite.splice(opposite.indexOf(resting as Order & { limitPrice: Cents }), 1);
        this.orders.delete(resting.id);
      }

      const trade: Trade = {
        clubId: order.clubId,
        price: fill.price,
        quantity: fill.quantity,
        buyerId: fill.buyerId,
        sellerId: fill.sellerId,
        buyOrderId: fill.buyOrderId,
        sellOrderId: fill.sellOrderId,
        aggressor: order.side,
        at: this.now,
      };
      trades.push(trade);
      this.lastTrade.set(trade.clubId, trade.price);
      const withHouse = this.house.has(trade.buyerId) || this.house.has(trade.sellerId);
      if (this.houseTradesSetPrice || !withHouse) {
        this.lastPeerTrade.set(trade.clubId, trade.price);
      }
      for (const l of this.listeners) l(trade);
    }

    if (order.remaining === 0) return { status: "filled", order, trades };

    if (!result.rests) {
      // Sobra de ordem a mercado não fica no livro.
      this.apply(order.accountId, order.clubId, remainderRelease(order, order.remaining));
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
    this.apply(order.accountId, order.clubId, remainderRelease(order, order.remaining));
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
    if (this.selfTrade === "reject" && selfTradeConflict(req, this.openOrders(req.accountId, req.clubId) as Array<Order & { limitPrice: Cents }>)) {
      return "ordem contra si mesmo";
    }
    return undefined;
  }

  /** Aplica no `Ledger` uma variação de saldos: primeiro solta reservas, depois move, depois prende. */
  private apply(accountId: string, clubId: string, d: BalanceDelta): void {
    if (d.reservedCash < 0) this.ledger.releaseCash(accountId, -d.reservedCash);
    if (d.reservedShares < 0) this.ledger.releaseShares(accountId, clubId, -d.reservedShares);
    if (d.cash !== 0) this.ledger.adjustCash(accountId, d.cash);
    if (d.shares !== 0) this.ledger.adjustShares(accountId, clubId, d.shares);
    if (d.reservedCash > 0) this.ledger.reserveCash(accountId, d.reservedCash);
    if (d.reservedShares > 0) this.ledger.reserveShares(accountId, clubId, d.reservedShares);
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

  private book(clubId: string): Book {
    let b = this.books.get(clubId);
    if (!b) {
      b = { bids: [], asks: [] };
      this.books.set(clubId, b);
    }
    return b;
  }
}
