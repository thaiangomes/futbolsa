import { computeStandings, type LeagueRules, type StandingRow } from "../engine/dividends.js";
import type { Ledger } from "../engine/ledger.js";
import { MIN_PRICE, type Cents } from "../engine/money.js";
import type { Exchange, Side } from "../engine/orderbook.js";
import { finishTime, type Match } from "../engine/types.js";

/**
 * O que os bots enxergam do mercado e do campeonato num instante: preços,
 * histórico diário, tabela com os jogos já encerrados e uma estimativa do
 * valor justo de cada ação (dividendos que ainda devem vir na temporada).
 */
export class MarketView {
  now = 0;
  readonly history = new Map<string, Cents[]>();
  private known: Match[] = [];
  private standings = new Map<string, StandingRow>();
  private projectedRank = new Map<string, number>();
  /** Pontos já pagos em dividendos, por clube. */
  readonly paidPoints = new Map<string, number>();
  placementPaid = false;
  /** Recompra no fim da temporada, em múltiplos dos dividendos dela (0 = sem recompra). */
  buybackMultiple = 0;
  private readonly gamesPerClub: number;

  constructor(
    readonly exchange: Exchange,
    readonly ledger: Ledger,
    readonly clubIds: readonly string[],
    private readonly rules: LeagueRules,
    allMatches: readonly Match[],
    /** Pontos por jogo esperados antes de qualquer resultado. */
    private readonly priorPpg = 1.35,
    /** Peso do palpite inicial, em jogos. */
    private readonly priorWeight = 5,
  ) {
    this.gamesPerClub = (2 * allMatches.length) / clubIds.length;
    for (const id of clubIds) {
      this.history.set(id, []);
      this.paidPoints.set(id, 0);
    }
    this.recompute();
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

  setKnownMatches(matches: Match[]): void {
    this.known = matches;
    this.recompute();
  }

  lastResult(clubId: string): { result: "W" | "D" | "L"; at: number } | undefined {
    for (let i = this.known.length - 1; i >= 0; i--) {
      const m = this.known[i]!;
      if (m.home !== clubId && m.away !== clubId) continue;
      const mine = m.home === clubId ? m.homeGoals! : m.awayGoals!;
      const theirs = m.home === clubId ? m.awayGoals! : m.homeGoals!;
      return { result: mine > theirs ? "W" : mine < theirs ? "L" : "D", at: finishTime(m) };
    }
    return undefined;
  }

  /**
   * Valor justo estimado: pontos já ganhos e ainda não pagos, mais os pontos
   * esperados nos jogos que faltam, vezes o dividendo por ponto, mais o
   * dividendo da colocação final projetada, mais a recompra esperada (o
   * múltiplo vezes os dividendos projetados da temporada inteira).
   */
  fairValue(clubId: string): Cents {
    const row = this.standings.get(clubId);
    const played = row?.played ?? 0;
    const points = row?.points ?? 0;
    const remaining = Math.max(0, this.gamesPerClub - played);
    const ppg = this.ppg(clubId);
    const unpaid = points - (this.paidPoints.get(clubId) ?? 0);
    const projectedPlacement = this.rules.placement[this.projectedRank.get(clubId)! - 1] ?? 0;
    const placement = this.placementPaid ? 0 : projectedPlacement;
    const seasonTotal = (points + ppg * remaining) * this.rules.perPoint + projectedPlacement;
    return Math.round((unpaid + ppg * remaining) * this.rules.perPoint + placement + this.buybackMultiple * seasonTotal);
  }

  private ppg(clubId: string): number {
    const row = this.standings.get(clubId);
    return ((row?.points ?? 0) + this.priorPpg * this.priorWeight) / ((row?.played ?? 0) + this.priorWeight);
  }

  private recompute(): void {
    this.standings = new Map(computeStandings(this.known).map((r) => [r.clubId, r]));
    const projected = this.clubIds.map((id) => {
      const row = this.standings.get(id);
      const remaining = Math.max(0, this.gamesPerClub - (row?.played ?? 0));
      return { id, final: (row?.points ?? 0) + this.ppg(id) * remaining };
    });
    projected.sort((a, b) => b.final - a.final);
    this.projectedRank = new Map(projected.map((p, i) => [p.id, i + 1]));
  }

  /** Patrimônio a preços atuais. */
  netWorth(accountId: string): Cents {
    const account = this.ledger.get(accountId);
    let total = account.cash;
    for (const [clubId, p] of account.positions) total += p.shares * this.price(clubId);
    return total;
  }

  /** Coloca ordem limitada ajustando preço mínimo e quantidade ao saldo livre. */
  limit(accountId: string, clubId: string, side: Side, quantity: number, price: number): void {
    const limitPrice = Math.max(MIN_PRICE, Math.round(price));
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
