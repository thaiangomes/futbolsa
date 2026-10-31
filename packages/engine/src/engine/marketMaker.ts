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

// Valor justo com faixa de 10% (14% durante os jogos): decisão do Thaian em 2026-10-30, rodada T.
export const DEFAULT_MARKET_MAKER: MarketMakerConfig = {
  spread: 0.1,
  quantity: 100,
  matchSpread: 0.14,
  matchQuantity: 25,
  anchor: "fair",
};

/** Formador das rodadas antigas da calibração: último negócio com spread de 2% (6% nos jogos). */
export const LAST_TRADE_MARKET_MAKER: MarketMakerConfig = { ...DEFAULT_MARKET_MAKER, spread: 0.02, matchSpread: 0.06, anchor: "lastTrade" };

export interface Quote {
  bid?: { price: Cents; quantity: number };
  ask?: { price: Cents; quantity: number };
}

/**
 * Quantidade da casa por lado: uma fração das ações do clube (oferta do IPO,
 * lote do formador e emitidas para novatos), em pontos-base (25 = 0,25%),
 * arredondada para baixo, com o mínimo por lado quando houver e pelo menos 1.
 */
export function quoteSize(clubShares: number, basisPoints: number, minimum = 0): number {
  if (!Number.isSafeInteger(clubShares) || clubShares < 0) throw new Error("Ações do clube inválidas");
  return Math.max(Math.floor((clubShares * basisPoints) / 10_000), minimum, 1);
}

export interface QuoteOptions {
  /** Quantidade por lado vinda de `quoteSize`; sem ela, vale a da configuração (100 e 25 da simulação). */
  quantity?: number;
}

/** Calcula a cotação sem tocar no livro (função pura, fácil de testar). */
export function computeQuote(
  reference: Cents,
  inMatch: boolean,
  availableCash: Cents,
  availableShares: number,
  config: MarketMakerConfig = DEFAULT_MARKET_MAKER,
  options: QuoteOptions = {},
): Quote {
  const spread = inMatch ? config.matchSpread : config.spread;
  const size = options.quantity ?? (inMatch ? config.matchQuantity : config.quantity);
  // Em pontos-base e conta inteira: com número decimal, 0,93 não é exato e
  // R$ 42,00 × 0,93 sairia R$ 39,05 em vez de R$ 39,06.
  const bp = Math.round(spread * 10_000);

  let bidPrice = Math.max(MIN_PRICE, Math.floor((reference * (20_000 - bp)) / 20_000));
  let askPrice = Math.max(MIN_PRICE, Math.ceil((reference * (20_000 + bp)) / 20_000));
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
