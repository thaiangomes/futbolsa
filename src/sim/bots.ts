import type { Bid, PriceBand } from "../engine/bookbuilding.js";
import type { Cents } from "../engine/money.js";
import { finishTime, kickoffTime, type Match } from "../engine/types.js";
import type { MarketView } from "./market.js";
import type { Rng } from "./rng.js";

/**
 * Perfis de bots. Desde a rodada H todos partem do valor justo (os dividendos
 * esperados mais a recompra), e cada um tem um viés que às vezes fala mais alto:
 * - dividendos: só o valor justo, sem viés; é a referência;
 * - momentum: às vezes compra caro um clube que vem de vitórias ou de alta;
 * - torcedor: às vezes compra caro o próprio time depois de vitória, e demora
 *   mais para vendê-lo;
 * - aleatório: gera volume com ordens perto do preço, mas não compra muito acima
 *   do justo nem vende muito abaixo;
 * - trader: compra antes do jogo o clube que deve vencer, sem pagar muito
 *   acima do valor justo, segura até o resultado e vende o resto.
 */
export type BotProfile = "dividendos" | "momentum" | "torcedor" | "aleatorio" | "trader";

export const PROFILES: BotProfile[] = ["dividendos", "momentum", "torcedor", "aleatorio", "trader"];

export interface Bot {
  readonly id: string;
  readonly profile: BotProfile;
  /** Intenções de compra no IPO (soma de quantidade × preço máximo <= caixa). */
  ipoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid>;
  act(view: MarketView): void;
}

abstract class BaseBot implements Bot {
  abstract readonly profile: BotProfile;
  constructor(
    readonly id: string,
    protected readonly rng: Rng,
  ) {}
  abstract ipoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid>;
  abstract act(view: MarketView): void;

  protected bid(quantity: number, maxPrice: number): Bid | undefined {
    const q = Math.floor(quantity);
    return q > 0 ? { investorId: this.id, quantity: q, maxPrice: Math.round(maxPrice) } : undefined;
  }
}

/** Base dos perfis que olham o valor justo, com um erro pessoal de estimativa e uma margem. */
abstract class ValueBot extends BaseBot {
  protected readonly margin: number;
  private readonly noise = new Map<string, number>();

  constructor(id: string, rng: Rng) {
    super(id, rng);
    this.margin = rng.uniform(0.05, 0.2);
  }

  protected estimate(view: MarketView, clubId: string): number {
    let e = this.noise.get(clubId);
    if (e === undefined) {
      e = this.rng.normal(0, 0.1);
      this.noise.set(clubId, e);
    }
    return view.fairValue(clubId) * (1 + e);
  }

  /** No IPO só entra nos clubes em que o justo menos a margem cabe na faixa. */
  protected valueIpoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents, skip?: string): Map<string, Bid> {
    const bids = new Map<string, Bid>();
    const targets = [...bands].filter(
      ([clubId, band]) => clubId !== skip && this.estimate(view, clubId) * (1 - this.margin) >= band.min,
    );
    const budget = cash / Math.max(1, targets.length);
    for (const [clubId, band] of targets) {
      const maxPrice = Math.min(band.max, this.estimate(view, clubId) * (1 - this.margin));
      const b = this.bid(budget / maxPrice, maxPrice);
      if (b) bids.set(clubId, b);
    }
    return bids;
  }

  /** Compra abaixo do justo menos a margem; vende metade acima do justo mais `sellAbove`. */
  protected tradeOnValue(view: MarketView, clubId: string, worth: number, sellAbove = this.margin): void {
    const price = view.price(clubId);
    const fair = this.estimate(view, clubId);
    if (price < fair * (1 - this.margin)) {
      const limit = Math.min(fair * (1 - this.margin), price * 1.03);
      view.limit(this.id, clubId, "buy", (worth * 0.15) / limit, limit);
    } else if (price > fair * (1 + sellAbove)) {
      const held = view.ledger.availableShares(this.id, clubId);
      if (held > 0) view.limit(this.id, clubId, "sell", Math.ceil(held / 2), Math.max(fair * (1 + sellAbove), price * 0.97));
    }
  }
}

export class DividendBot extends ValueBot {
  readonly profile = "dividendos";

  ipoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    return this.valueIpoBids(view, bands, cash * 0.9);
  }

  act(view: MarketView): void {
    view.exchange.cancelAll(this.id);
    const worth = view.netWorth(this.id);
    for (const clubId of this.rng.shuffle([...view.clubIds]).slice(0, 4)) this.tradeOnValue(view, clubId, worth);
  }
}

export class MomentumBot extends ValueBot {
  readonly profile = "momentum";
  private readonly lookback: number;
  private readonly threshold: number;
  /** Quanto aceita pagar acima do justo quando se empolga. */
  private readonly bias: number;

  constructor(id: string, rng: Rng) {
    super(id, rng);
    this.lookback = rng.int(2, 7);
    this.threshold = rng.uniform(0.02, 0.06);
    this.bias = rng.uniform(0.2, 0.4);
  }

  ipoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    return this.valueIpoBids(view, bands, cash * 0.9);
  }

  act(view: MarketView): void {
    view.exchange.cancelAll(this.id);
    const worth = view.netWorth(this.id);
    for (const clubId of this.rng.shuffle([...view.clubIds]).slice(0, 5)) {
      const price = view.price(clubId);
      const past = view.priceDaysAgo(clubId, this.lookback);
      const hot = view.winStreak(clubId) >= 3 || (past !== undefined && price / past - 1 > this.threshold);
      // Às vezes (metade das vezes) se empolga com a fase boa e paga acima do justo.
      if (hot && this.rng.chance(0.5)) {
        const held = view.ledger.availableShares(this.id, clubId);
        const room = worth * 0.15 - held * price;
        const limit = Math.min(price * 1.01, this.estimate(view, clubId) * (1 + this.bias));
        if (room > 0) view.limit(this.id, clubId, "buy", Math.min(worth * 0.05, room) / limit, limit);
      } else {
        this.tradeOnValue(view, clubId, worth);
      }
    }
  }
}

export class FanBot extends ValueBot {
  readonly profile = "torcedor";
  private lastSeen = 0;
  /** Quanto aceita pagar acima do justo pelo próprio time. */
  private readonly bias: number;

  constructor(
    id: string,
    rng: Rng,
    readonly club: string,
  ) {
    super(id, rng);
    this.bias = rng.uniform(0.3, 0.5);
  }

  ipoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    // 40% do caixa no próprio time, aceitando pagar acima do justo; o resto pelo valor.
    const bids = this.valueIpoBids(view, bands, cash * 0.5, this.club);
    const band = bands.get(this.club)!;
    const maxPrice = Math.min(band.max, this.estimate(view, this.club) * (1 + this.bias));
    const b = maxPrice >= band.min ? this.bid((cash * 0.4) / maxPrice, maxPrice) : undefined;
    if (b) bids.set(this.club, b);
    return bids;
  }

  act(view: MarketView): void {
    view.exchange.cancelAll(this.id);
    const worth = view.netWorth(this.id);
    const last = view.lastResult(this.club);
    const newWin = last !== undefined && last.at > this.lastSeen && last.result === "W";
    if (last) this.lastSeen = Math.max(this.lastSeen, last.at);
    // Às vezes (30% das vitórias) a emoção fala mais alto e compra caro o próprio time.
    if (newWin && this.rng.chance(0.3)) {
      const price = view.price(this.club);
      const limit = Math.min(price * 1.03, this.estimate(view, this.club) * (1 + this.bias));
      view.limit(this.id, this.club, "buy", (view.ledger.availableCash(this.id) * 0.3) / limit, limit);
    } else {
      // Pelo valor, mas só vende o próprio time bem acima do justo.
      this.tradeOnValue(view, this.club, worth, this.bias);
    }
    for (const clubId of this.rng.shuffle(view.clubIds.filter((id) => id !== this.club)).slice(0, 3)) {
      this.tradeOnValue(view, clubId, worth);
    }
  }
}

export class RandomBot extends BaseBot {
  readonly profile = "aleatorio";
  private readonly targetInStocks: number;

  constructor(id: string, rng: Rng) {
    super(id, rng);
    this.targetInStocks = rng.uniform(0.5, 0.8);
  }

  ipoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    const bids = new Map<string, Bid>();
    const chosen = this.rng.shuffle([...bands.keys()]).slice(0, 8);
    const budget = (cash * 0.9) / chosen.length;
    for (const clubId of chosen) {
      const band = bands.get(clubId)!;
      const maxPrice = Math.min(this.rng.uniform(band.min, band.max), view.fairValue(clubId) * 1.1);
      const b = maxPrice >= band.min ? this.bid(budget / maxPrice, maxPrice) : undefined;
      if (b) bids.set(clubId, b);
    }
    return bids;
  }

  act(view: MarketView): void {
    view.exchange.cancelAll(this.id);
    const worth = view.netWorth(this.id);
    // Mantém perto de uma fração-alvo do patrimônio em ações; fora da faixa,
    // pende para comprar ou vender. Sem isso o caixa sobrando só empurra preço.
    const inStocks = (worth - view.ledger.get(this.id).cash) / worth;
    const buyChance = inStocks < this.targetInStocks - 0.05 ? 0.8 : inStocks > this.targetInStocks + 0.05 ? 0.2 : 0.5;
    const orders = this.rng.int(1, 2);
    for (let i = 0; i < orders; i++) {
      const side = this.rng.chance(buyChance) ? "buy" : "sell";
      const owned = view.clubIds.filter((id) => view.ledger.availableShares(this.id, id) > 0);
      if (side === "sell" && owned.length === 0) continue;
      const clubId = this.rng.pick(side === "sell" ? owned : view.clubIds);
      const price = view.price(clubId);
      const held = view.ledger.availableShares(this.id, clubId);
      const quantity = Math.max(1, (worth * this.rng.uniform(0.01, 0.03)) / price);
      const limit = price * (1 + this.rng.normal(0, 0.015));
      // Não compra mais de 10% acima do justo nem vende mais de 10% abaixo dele.
      const fair = view.fairValue(clubId);
      if (side === "buy" ? limit > fair * 1.1 : limit < fair * 0.9) continue;
      if (this.rng.chance(0.2)) {
        view.market(this.id, clubId, side, side === "sell" ? Math.min(held, quantity) : quantity);
      } else {
        view.limit(this.id, clubId, side, quantity, limit);
      }
    }
  }
}

const HOUR_MS = 60 * 60 * 1000;
const OUTCOMES = ["H", "D", "A"] as const;

export class TraderBot extends BaseBot {
  readonly profile = "trader";
  /** Vantagem mínima esperada no próximo jogo, em pontos por jogo (palpite pela campanha). */
  private readonly threshold: number;
  /** Quanto aceita pagar acima do valor justo. */
  private readonly tolerance: number;
  /** Com quanta antecedência do jogo passa a comprar. */
  private readonly horizon: number;
  /** Jogo em que apostou, por clube: segura a ação até sair o resultado dele. */
  private readonly bets = new Map<string, Match>();
  /** Palpite de cada jogo (vitória do mandante, empate ou do visitante), sorteado uma vez. */
  private readonly guesses = new Map<string, (typeof OUTCOMES)[number]>();

  constructor(
    id: string,
    rng: Rng,
    /**
     * Taxa de acerto do palpite (0 a 1). Sem ela, o palpite vem da campanha dos
     * dois times; com ela, a simulação usa o resultado real para fazer o trader
     * acertar o resultado nessa proporção dos jogos, como um jogador mais ou
     * menos habilidoso.
     */
    readonly hitRate?: number,
  ) {
    super(id, rng);
    this.threshold = rng.uniform(0.2, 0.5);
    this.tolerance = rng.uniform(0.1, 0.3);
    this.horizon = rng.uniform(24, 72) * HOUR_MS;
  }

  ipoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    const bids = new Map<string, Bid>();
    // No IPO só entra onde o preço cabe no valor justo; o resto do caixa fica para os jogos.
    const targets = [...bands].filter(([clubId, band]) => view.fairValue(clubId) >= band.min);
    const budget = (cash * 0.4) / Math.max(1, targets.length);
    for (const [clubId, band] of targets) {
      const maxPrice = Math.min(band.max, view.fairValue(clubId));
      const b = this.bid(budget / maxPrice, maxPrice);
      if (b) bids.set(clubId, b);
    }
    return bids;
  }

  private expectsWin(view: MarketView, clubId: string, match: Match): boolean {
    if (this.hitRate === undefined) return view.matchEdge(clubId, match) > this.threshold;
    let guess = this.guesses.get(match.id);
    if (guess === undefined) {
      const real = match.homeGoals! > match.awayGoals! ? "H" : match.homeGoals! < match.awayGoals! ? "A" : "D";
      guess = this.rng.chance(this.hitRate) ? real : this.rng.pick(OUTCOMES.filter((o) => o !== real));
      this.guesses.set(match.id, guess);
    }
    return guess === (match.home === clubId ? "H" : "A");
  }

  act(view: MarketView): void {
    view.exchange.cancelAll(this.id);
    const worth = view.netWorth(this.id);
    for (const clubId of view.clubIds) {
      const price = view.price(clubId);
      const fair = view.fairValue(clubId);
      const held = view.ledger.availableShares(this.id, clubId);
      const bet = this.bets.get(clubId);
      // Segura a ação até sair o resultado do jogo em que apostou.
      if (held > 0 && bet && view.now < finishTime(bet)) continue;
      const next = view.nextMatch(clubId);
      const soon = next !== undefined && kickoffTime(next) - view.now <= this.horizon;
      const favored = soon && this.expectsWin(view, clubId, next);
      if (favored) this.bets.set(clubId, next);
      if (favored && price <= fair * (1 + this.tolerance)) {
        // Até 10% do patrimônio por clube.
        const room = worth * 0.1 - held * price;
        if (room > 0) view.limit(this.id, clubId, "buy", room / (price * 1.01), price * 1.01);
      } else if (held > 0 && !favored) {
        view.limit(this.id, clubId, "sell", held, price * 0.99);
      } else if (held > 0 && price > fair * (1 + this.tolerance)) {
        view.limit(this.id, clubId, "sell", held, Math.max(price * 0.99, fair));
      }
    }
  }
}
