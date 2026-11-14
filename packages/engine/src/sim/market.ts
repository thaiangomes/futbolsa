import type { LeagueRules } from "../engine/dividends.js";
import type { Ledger } from "../engine/ledger.js";
import { MIN_PRICE, type Cents } from "../engine/money.js";
import type { Exchange, Side } from "../engine/orderbook.js";
import { tradingBand } from "../engine/orderRules.js";
import type { Match } from "../engine/types.js";
import type { BotView } from "./botView.js";
import { LeagueView } from "./leagueView.js";

/**
 * O que os bots enxergam do mercado e do campeonato num instante: preços,
 * histórico diário, tabela com os jogos já encerrados e uma estimativa do
 * valor justo de cada ação (dividendos que ainda devem vir na temporada).
 * O campeonato é do `LeagueView`; aqui entram o mercado simulado (`Exchange`) e as carteiras (`Ledger`).
 */
export class MarketView extends LeagueView implements BotView {
  readonly history = new Map<string, Cents[]>();
  /** Regras do jogo: ordem limitada fora da faixa de 20% em volta do preço exibido é recusada (e contada). */
  enforceBand = false;
  readonly refused: Record<string, number> = {};

  constructor(
    readonly exchange: Exchange,
    readonly ledger: Ledger,
    clubIds: readonly string[],
    rules: LeagueRules,
    allMatches: readonly Match[],
    /** Pontos por jogo esperados antes de qualquer resultado. */
    priorPpg = 1.35,
    /** Peso do palpite inicial, em jogos. */
    priorWeight = 5,
  ) {
    super(clubIds, rules, allMatches, priorPpg, priorWeight);
    for (const id of clubIds) this.history.set(id, []);
  }

  price(clubId: string): Cents {
    return this.exchange.price(clubId) ?? MIN_PRICE;
  }

  /** Preço de `days` fechamentos diários atrás (ou o mais antigo disponível). */
  priceDaysAgo(clubId: string, days: number): Cents | undefined {
    const h = this.history.get(clubId)!;
    if (h.length === 0) return undefined;
    return h[Math.max(0, h.length - days)];
  }

  /** Patrimônio a preços atuais. */
  netWorth(accountId: string): Cents {
    const account = this.ledger.get(accountId);
    let total = account.cash;
    for (const [clubId, p] of account.positions) total += p.shares * this.price(clubId);
    return total;
  }

  availableCash(accountId: string): Cents {
    return this.ledger.availableCash(accountId);
  }

  availableShares(accountId: string, clubId: string): number {
    return this.ledger.availableShares(accountId, clubId);
  }

  cashOf(accountId: string): Cents {
    return this.ledger.get(accountId).cash;
  }

  cancelAll(accountId: string): void {
    this.exchange.cancelAll(accountId);
  }

  /** Coloca ordem limitada ajustando preço mínimo e quantidade ao saldo livre. */
  limit(accountId: string, clubId: string, side: Side, quantity: number, price: number): void {
    const limitPrice = Math.max(MIN_PRICE, Math.round(price));
    if (this.enforceBand) {
      const band = tradingBand(this.price(clubId));
      if (limitPrice < band.min || limitPrice > band.max) {
        this.refused.price_out_of_band = (this.refused.price_out_of_band ?? 0) + 1;
        return;
      }
    }
    const max =
      side === "buy"
        ? Math.floor(this.ledger.availableCash(accountId) / limitPrice)
        : this.ledger.availableShares(accountId, clubId);
    const qty = Math.min(Math.floor(quantity), max);
    if (qty <= 0) return;
    this.exchange.placeOrder({ accountId, clubId, side, type: "limit", quantity: qty, limitPrice });
  }

  market(accountId: string, clubId: string, side: Side, quantity: number): void {
    const qty =
      side === "sell" ? Math.min(Math.floor(quantity), this.ledger.availableShares(accountId, clubId)) : Math.floor(quantity);
    if (qty <= 0) return;
    this.exchange.placeOrder({ accountId, clubId, side, type: "market", quantity: qty });
  }
}
