import { computeStandings, type CupRules, type LeagueRules, type StandingRow } from "../engine/dividends.js";
import type { Ledger } from "../engine/ledger.js";
import { MIN_PRICE, type Cents } from "../engine/money.js";
import type { Exchange, Side } from "../engine/orderbook.js";
import { finishTime, kickoffTime, type Match } from "../engine/types.js";

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
  /** Dividendos de copa já pagos por ação, por clube. */
  readonly cupPaid = new Map<string, number>();
  /** Torcedores compram o próprio time antes dos mata-matas de copa. */
  cupHype = false;
  private cups: Cup[] = [];
  private readonly gamesPerClub: number;
  /** Jogos de cada clube em ordem de início, e o índice do próximo a começar. */
  private readonly fixtures = new Map<string, Match[]>();
  private readonly nextIdx = new Map<string, number>();

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
      this.fixtures.set(
        id,
        allMatches.filter((m) => m.home === id || m.away === id).sort((a, b) => kickoffTime(a) - kickoffTime(b)),
      );
      this.nextIdx.set(id, 0);
    }
    this.recompute();
  }

  /** Copas que valem dividendos nesta temporada, com todos os jogos (inclusive os que ainda vão acontecer). */
  setCups(cups: ReadonlyArray<{ matches: readonly Match[]; rules: CupRules }>): void {
    this.cups = cups.map(({ matches, rules }) => {
      const live = matches.filter((m) => m.status !== "cancelled");
      const phases = [...new Set([...live].sort((a, b) => kickoffTime(a) - kickoffTime(b)).map((m) => m.phase!))];
      const byPhase = new Map(phases.map((p) => [p, live.filter((m) => m.phase === p)]));
      const completeAt = new Map(
        phases.map((p) => {
          const list = byPhase.get(p)!;
          return [p, list.every((m) => m.status === "finished") ? Math.max(...list.map(finishTime)) : Infinity];
        }),
      );
      return { rules, phases, byPhase, completeAt };
    });
  }

  /**
   * Fase em que o clube está vivo na copa, só com o que já se sabe agora: ele
   * passa para a fase seguinte quando a atual termina e ele aparece nela.
   * -1 se não disputa, foi eliminado ou a copa acabou.
   */
  private cupStage(cup: Cup, clubId: string): number {
    const plays = (p: string) => cup.byPhase.get(p)!.some((m) => m.home === clubId || m.away === clubId);
    let i = cup.phases.findIndex(plays);
    if (i < 0) return -1;
    while (this.now >= cup.completeAt.get(cup.phases[i]!)!) {
      if (i === cup.phases.length - 1 || !plays(cup.phases[i + 1]!)) return -1;
      i++;
    }
    return i;
  }

  /**
   * Dividendos de copa que o clube ainda pode receber, esperados com metade de
   * chance de passar de cada fase (inclusive as preliminares, que não pagam).
   */
  cupExpected(clubId: string): Cents {
    let total = 0;
    for (const cup of this.cups) {
      const stage = this.cupStage(cup, clubId);
      if (stage < 0) continue;
      const first = cup.phases.indexOf(cup.rules.phases[0]!);
      const ahead = cup.rules.phases;
      // Fase atual dentro das que pagam; nas preliminares, ainda falta passar por elas.
      const start = Math.max(0, ahead.indexOf(cup.phases[stage]!));
      const pre = stage < first ? first - stage : 0;
      let chance = 0.5 ** pre;
      for (let j = start; j < ahead.length - 1; j++) {
        chance *= 0.5;
        total += chance * (cup.rules.advance[ahead[j]!] ?? 0);
      }
      total += chance * 0.5 * cup.rules.title;
    }
    return Math.round(total);
  }

  /** Próximo jogo de copa do clube na fase em que ele está vivo. */
  nextCupMatch(clubId: string): Match | undefined {
    let best: Match | undefined;
    for (const cup of this.cups) {
      const stage = this.cupStage(cup, clubId);
      if (stage < 0) continue;
      for (const m of cup.byPhase.get(cup.phases[stage]!)!) {
        if ((m.home !== clubId && m.away !== clubId) || kickoffTime(m) <= this.now) continue;
        if (!best || kickoffTime(m) < kickoffTime(best)) best = m;
      }
    }
    return best;
  }

  /** Próximo jogo do clube que ainda não começou (o tempo da simulação só anda para a frente). */
  nextMatch(clubId: string): Match | undefined {
    const list = this.fixtures.get(clubId)!;
    let i = this.nextIdx.get(clubId)!;
    while (i < list.length && kickoffTime(list[i]!) <= this.now) i++;
    this.nextIdx.set(clubId, i);
    return list[i];
  }

  /**
   * Vantagem esperada do clube no jogo: pontos por jogo dele menos os do
   * adversário, mais um bônus por jogar em casa (negativo fora).
   */
  matchEdge(clubId: string, match: Match, homeBonus = 0.3): number {
    const home = match.home === clubId;
    const opponent = home ? match.away : match.home;
    return this.ppg(clubId) - this.ppg(opponent) + (home ? homeBonus : -homeBonus);
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

  /** Dividendo por ação dos pontos já ganhos e ainda não pagos (sai no fechamento da rodada). */
  unpaidDividend(clubId: string): Cents {
    const points = this.standings.get(clubId)?.points ?? 0;
    return Math.round((points - (this.paidPoints.get(clubId) ?? 0)) * this.rules.perPoint);
  }

  /** Vitórias seguidas do clube nos últimos jogos encerrados. */
  winStreak(clubId: string): number {
    let n = 0;
    for (let i = this.known.length - 1; i >= 0; i--) {
      const m = this.known[i]!;
      if (m.home !== clubId && m.away !== clubId) continue;
      const mine = m.home === clubId ? m.homeGoals! : m.awayGoals!;
      const theirs = m.home === clubId ? m.awayGoals! : m.homeGoals!;
      if (mine <= theirs) break;
      n++;
    }
    return n;
  }

  /**
   * Valor justo estimado: pontos já ganhos e ainda não pagos, mais os pontos
   * esperados nos jogos que faltam, vezes o dividendo por ponto, mais o
   * dividendo da colocação final projetada, mais os dividendos de copa
   * esperados, mais a recompra esperada (o múltiplo vezes os dividendos
   * projetados da temporada inteira, copas incluídas).
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
    const cup = this.cupExpected(clubId);
    const seasonTotal = (points + ppg * remaining) * this.rules.perPoint + projectedPlacement + (this.cupPaid.get(clubId) ?? 0) + cup;
    return Math.round((unpaid + ppg * remaining) * this.rules.perPoint + placement + cup + this.buybackMultiple * seasonTotal);
  }

  /** Linha da tabela do clube com os jogos já encerrados. */
  standing(clubId: string): StandingRow | undefined {
    return this.standings.get(clubId);
  }

  /**
   * Valor justo com outra estimativa de pontos por jogo nos jogos que faltam
   * (a mesma conta de `fairValue`, inclusive a colocação projetada com ela).
   */
  fairValueWith(clubId: string, ppg: (clubId: string) => number): Cents {
    const final = (id: string) => {
      const row = this.standings.get(id);
      return (row?.points ?? 0) + ppg(id) * Math.max(0, this.gamesPerClub - (row?.played ?? 0));
    };
    const mine = final(clubId);
    const rank = 1 + this.clubIds.filter((id) => id !== clubId && final(id) > mine).length;
    const row = this.standings.get(clubId);
    const points = row?.points ?? 0;
    const unpaid = points - (this.paidPoints.get(clubId) ?? 0);
    const projectedPlacement = this.rules.placement[rank - 1] ?? 0;
    const placement = this.placementPaid ? 0 : projectedPlacement;
    const rest = mine - points;
    const cup = this.cupExpected(clubId);
    const seasonTotal = mine * this.rules.perPoint + projectedPlacement + (this.cupPaid.get(clubId) ?? 0) + cup;
    return Math.round((unpaid + rest) * this.rules.perPoint + placement + cup + this.buybackMultiple * seasonTotal);
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

interface Cup {
  rules: CupRules;
  /** Fases na ordem em que começam, inclusive as preliminares que não pagam. */
  phases: string[];
  byPhase: Map<string, Match[]>;
  /** Fim do último jogo de cada fase (Infinity se ainda falta jogo). */
  completeAt: Map<string, number>;
}
