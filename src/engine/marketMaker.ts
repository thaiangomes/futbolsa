import type { Ledger } from "./ledger.js";
import { MIN_PRICE, type Cents } from "./money.js";
import type { Exchange } from "./orderbook.js";

/**
 * Formador de mercado da casa: mantém uma oferta de compra e uma de venda perto
 * do último preço entre pessoas, com spread pequeno e quantidade limitada,
 * usando o caixa e as ações da tesouraria. Ele não sabe o placar, então durante
 * os jogos de um clube amplia o spread e reduz a quantidade daquele clube.
 */

export interface MarketMakerConfig {
  /** Spread total fora de jogo (0,02 = 2%: 1% abaixo e 1% acima do preço). */
  spread: number;
  /** Quantidade por lado fora de jogo. */
  quantity: number;
  /** Spread total enquanto o clube está em campo. */
  matchSpread: number;
  /** Quantidade por lado enquanto o clube está em campo. */
  matchQuantity: number;
  /**
   * Em volta de qual preço cotar:
   * - "lastTrade": último negócio, inclusive os da própria casa. Quem vende
   *   para a casa empurra a próxima cotação para baixo (e quem compra, para cima).
   * - "peer": último negócio entre pessoas. Na Fase 0 isso criou um piso: a casa
   *   recomprava sempre no mesmo preço enquanto só ela comprava.
   * - "fair": o valor que a casa considera justo para o clube (dividendos que
   *   faltam e recompra esperados). Negócios, com a casa ou entre pessoas, não
   *   mexem na cotação; ela só muda quando um jogo termina ou um dividendo é pago.
   */
  anchor: "lastTrade" | "peer" | "fair";
}

export const DEFAULT_MARKET_MAKER: MarketMakerConfig = {
  spread: 0.02,
  quantity: 100,
  matchSpread: 0.06,
  matchQuantity: 25,
  anchor: "lastTrade",
};

export interface Quote {
  bid?: { price: Cents; quantity: number };
  ask?: { price: Cents; quantity: number };
}

/** Calcula a cotação sem tocar no livro (função pura, fácil de testar). */
export function computeQuote(
  reference: Cents,
  inMatch: boolean,
  availableCash: Cents,
  availableShares: number,
  config: MarketMakerConfig = DEFAULT_MARKET_MAKER,
): Quote {
  const spread = inMatch ? config.matchSpread : config.spread;
  const size = inMatch ? config.matchQuantity : config.quantity;
  const half = spread / 2;

  let bidPrice = Math.max(MIN_PRICE, Math.floor(reference * (1 - half)));
  let askPrice = Math.max(MIN_PRICE, Math.ceil(reference * (1 + half)));
  // Em preços muito baixos o arredondamento pode colar os dois lados.
  if (askPrice <= bidPrice) askPrice = bidPrice + 1;
  if (bidPrice >= reference && reference > MIN_PRICE) bidPrice = reference - 1;

  const quote: Quote = {};
  const bidQty = Math.min(size, Math.floor(availableCash / bidPrice));
  if (bidQty > 0) quote.bid = { price: bidPrice, quantity: bidQty };
  const askQty = Math.min(size, availableShares);
  if (askQty > 0) quote.ask = { price: askPrice, quantity: askQty };
  return quote;
}

export class MarketMaker {
  constructor(
    private readonly exchange: Exchange,
    private readonly ledger: Ledger,
    readonly accountId: string,
    private readonly config: MarketMakerConfig = DEFAULT_MARKET_MAKER,
    /** Valor justo de cada clube, usado com a âncora "fair". */
    private readonly fairValue?: (clubId: string) => Cents,
  ) {}

  /**
   * Cancela as cotações anteriores do clube e coloca novas em volta do preço
   * atual. Chamado periodicamente (no jogo, a cada poucos minutos).
   */
  refresh(clubId: string, inMatch: boolean): Quote {
    this.exchange.cancelAll(this.accountId, clubId);
    const reference =
      this.config.anchor === "fair" && this.fairValue
        ? Math.max(MIN_PRICE, this.fairValue(clubId))
        : this.config.anchor === "lastTrade"
          ? (this.exchange.lastTradePrice(clubId) ?? this.exchange.price(clubId))
          : this.exchange.price(clubId);
    if (reference === undefined) return {};
    const quote = computeQuote(
      reference,
      inMatch,
      this.ledger.availableCash(this.accountId),
      this.ledger.availableShares(this.accountId, clubId),
      this.config,
    );
    if (quote.bid) {
      this.exchange.placeOrder({
        accountId: this.accountId,
        clubId,
        side: "buy",
        type: "limit",
        quantity: quote.bid.quantity,
        limitPrice: quote.bid.price,
      });
    }
    if (quote.ask) {
      this.exchange.placeOrder({
        accountId: this.accountId,
        clubId,
        side: "sell",
        type: "limit",
        quantity: quote.ask.quantity,
        limitPrice: quote.ask.price,
      });
    }
    return quote;
  }
}
