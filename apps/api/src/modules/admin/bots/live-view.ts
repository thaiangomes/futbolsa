import { MIN_PRICE, type BotView, type Cents, type LeagueView, type Match, type StandingRow } from "@futbolsa/engine";

/** A carteira de um bot, lida do banco sem trava e mantida em memória durante a rodada. */
export interface BotWalletState {
  cash: Cents;
  reservedCash: Cents;
  /** Por ticker. */
  positions: Map<string, { shares: number; reservedShares: number }>;
}

/** O que a visão ao vivo enxerga do mercado numa rodada. Montado uma vez por rodada (`loadBotSnapshot`). */
export interface BotSnapshot {
  /** O instante, em ms. */
  now: number;
  /** Os clubes listados, por ticker, em ordem. */
  clubIds: string[];
  /** O preço exibido de cada clube. */
  prices: ReadonlyMap<string, Cents>;
  /** Os fechamentos diários de cada clube, do mais antigo para o mais novo. */
  dailyCloses: ReadonlyMap<string, readonly Cents[]>;
  /** A visão do campeonato de cada clube listado. */
  leagues: ReadonlyMap<string, LeagueView>;
  /** As carteiras dos bots ativos, por id do bot (como texto). */
  wallets: ReadonlyMap<string, BotWalletState>;
  cupHype?: boolean;
}

/** O que um bot quis fazer; a tarefa dos bots manda cada uma ao mercado. */
export type BotIntent =
  | { kind: "cancelAll"; botId: string }
  | { kind: "limit"; botId: string; ticker: string; side: "buy" | "sell"; quantity: number; limitPrice: Cents }
  | { kind: "market"; botId: string; ticker: string; side: "buy" | "sell"; quantity: number };

/**
 * A `BotView` ao vivo (F14, T11): o mesmo que os perfis veem na simulação, montado do banco. O campeonato (valor justo,
 * colocação, vantagem, próximos jogos) vem das `LeagueView` do motor, as mesmas contas da simulação. Não abre transação,
 * não trava nada e **não escreve**: as ordens viram intenções (`intents`), com a mesma limitação de quantidade ao caixa
 * e às ações livres da simulação, descontando da carteira em memória para o bot não prometer o que já prometeu.
 */
export class LiveBotView implements BotView {
  readonly intents: BotIntent[] = [];
  readonly now: number;
  readonly clubIds: readonly string[];
  readonly cupHype: boolean;

  constructor(private readonly snapshot: BotSnapshot) {
    this.now = snapshot.now;
    this.clubIds = snapshot.clubIds;
    this.cupHype = snapshot.cupHype ?? false;
  }

  private league(clubId: string): LeagueView {
    const league = this.snapshot.leagues.get(clubId);
    if (!league) throw new Error(`clube ${clubId} sem campeonato na visão dos bots`);
    return league;
  }

  price(clubId: string): Cents {
    return this.snapshot.prices.get(clubId) ?? MIN_PRICE;
  }

  priceDaysAgo(clubId: string, days: number): Cents | undefined {
    const h = this.snapshot.dailyCloses.get(clubId);
    if (!h || h.length === 0) return undefined;
    return h[Math.max(0, h.length - days)];
  }

  fairValue(clubId: string): Cents {
    return this.league(clubId).fairValue(clubId);
  }

  fairValueWith(clubId: string, ppg: (clubId: string) => number): Cents {
    return this.league(clubId).fairValueWith(clubId, ppg);
  }

  unpaidDividend(clubId: string): Cents {
    return this.league(clubId).unpaidDividend(clubId);
  }

  standing(clubId: string): StandingRow | undefined {
    return this.league(clubId).standing(clubId);
  }

  winStreak(clubId: string): number {
    return this.league(clubId).winStreak(clubId);
  }

  lastResult(clubId: string) {
    return this.league(clubId).lastResult(clubId);
  }

  nextMatch(clubId: string): Match | undefined {
    return this.league(clubId).nextMatch(clubId);
  }

  nextCupMatch(clubId: string): Match | undefined {
    return this.league(clubId).nextCupMatch(clubId);
  }

  matchEdge(clubId: string, match: Match, homeBonus?: number): number {
    return this.league(clubId).matchEdge(clubId, match, homeBonus);
  }

  private wallet(botId: string): BotWalletState {
    const w = this.snapshot.wallets.get(botId);
    if (!w) throw new Error(`bot ${botId} sem carteira na visão`);
    return w;
  }

  netWorth(botId: string): Cents {
    const w = this.wallet(botId);
    let total = w.cash;
    for (const [ticker, p] of w.positions) total += p.shares * this.price(ticker);
    return total;
  }

  availableCash(botId: string): Cents {
    const w = this.wallet(botId);
    return w.cash - w.reservedCash;
  }

  availableShares(botId: string, clubId: string): number {
    const p = this.wallet(botId).positions.get(clubId);
    return p ? p.shares - p.reservedShares : 0;
  }

  cashOf(botId: string): Cents {
    return this.wallet(botId).cash;
  }

  limit(botId: string, clubId: string, side: "buy" | "sell", quantity: number, price: number): void {
    const limitPrice = Math.max(MIN_PRICE, Math.round(price));
    const max = side === "buy" ? Math.floor(this.availableCash(botId) / limitPrice) : this.availableShares(botId, clubId);
    const qty = Math.min(Math.floor(quantity), max);
    if (qty <= 0) return;
    const w = this.wallet(botId);
    if (side === "buy") w.reservedCash += qty * limitPrice;
    else {
      const p = w.positions.get(clubId)!;
      p.reservedShares += qty;
    }
    this.intents.push({ kind: "limit", botId, ticker: clubId, side, quantity: qty, limitPrice });
  }

  market(botId: string, clubId: string, side: "buy" | "sell", quantity: number): void {
    const qty = side === "sell" ? Math.min(Math.floor(quantity), this.availableShares(botId, clubId)) : Math.floor(quantity);
    if (qty <= 0) return;
    if (side === "sell") this.wallet(botId).positions.get(clubId)!.reservedShares += qty;
    this.intents.push({ kind: "market", botId, ticker: clubId, side, quantity: qty });
  }

  cancelAll(botId: string): void {
    // as reservas só vêm de ordens abertas: cancelar todas libera todas
    const w = this.wallet(botId);
    w.reservedCash = 0;
    for (const p of w.positions.values()) p.reservedShares = 0;
    this.intents.push({ kind: "cancelAll", botId });
  }
}
