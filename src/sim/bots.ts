import type { Bid, PriceBand } from "../engine/bookbuilding.js";
import type { Cents } from "../engine/money.js";
import type { MarketView } from "./market.js";
import type { Rng } from "./rng.js";

/**
 * Perfis de bots da Fase 0:
 * - dividendos: compra o que está barato frente aos dividendos esperados e
 *   vende o que está caro;
 * - momentum: segue a tendência dos últimos dias;
 * - torcedor: só compra o próprio time, mais depois de vitória;
 * - aleatório: gera volume com ordens perto do preço.
 */
export type BotProfile = "dividendos" | "momentum" | "torcedor" | "aleatorio";

export const PROFILES: BotProfile[] = ["dividendos", "momentum", "torcedor", "aleatorio"];

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

export class DividendBot extends BaseBot {
  readonly profile = "dividendos";
  private readonly margin: number;
  private readonly noise = new Map<string, number>();

  constructor(id: string, rng: Rng) {
    super(id, rng);
    this.margin = rng.uniform(0.05, 0.2);
  }

  private estimate(view: MarketView, clubId: string): number {
    let e = this.noise.get(clubId);
    if (e === undefined) {
      e = this.rng.normal(0, 0.1);
      this.noise.set(clubId, e);
    }
    return view.fairValue(clubId) * (1 + e);
  }

  ipoBids(view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    const bids = new Map<string, Bid>();
    const targets = [...bands].filter(([clubId, band]) => this.estimate(view, clubId) * (1 - this.margin) >= band.min);
    const budget = (cash * 0.9) / Math.max(1, targets.length);
    for (const [clubId, band] of targets) {
      const maxPrice = Math.min(band.max, this.estimate(view, clubId) * (1 - this.margin));
      const b = this.bid(budget / maxPrice, maxPrice);
      if (b) bids.set(clubId, b);
    }
    return bids;
  }

  act(view: MarketView): void {
    view.exchange.cancelAll(this.id);
    const worth = view.netWorth(this.id);
    for (const clubId of this.rng.shuffle([...view.clubIds]).slice(0, 4)) {
      const price = view.price(clubId);
      const fair = this.estimate(view, clubId);
      if (price < fair * (1 - this.margin)) {
        const limit = Math.min(fair * (1 - this.margin), price * 1.03);
        view.limit(this.id, clubId, "buy", (worth * 0.15) / limit, limit);
      } else if (price > fair * (1 + this.margin)) {
        const held = view.ledger.availableShares(this.id, clubId);
        if (held > 0) view.limit(this.id, clubId, "sell", Math.ceil(held / 2), Math.max(fair * (1 + this.margin), price * 0.97));
      }
    }
  }
}

export class MomentumBot extends BaseBot {
  readonly profile = "momentum";
  private readonly lookback: number;
  private readonly threshold: number;

  constructor(id: string, rng: Rng) {
    super(id, rng);
    this.lookback = rng.int(2, 7);
    this.threshold = rng.uniform(0.02, 0.06);
  }

  ipoBids(_view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    const bids = new Map<string, Bid>();
    const budget = (cash * 0.9) / bands.size;
    for (const [clubId, band] of bands) {
      const maxPrice = Math.min(band.max, Math.max(band.min, band.center * (1 + this.rng.uniform(-0.2, 0.4))));
      const b = this.bid(budget / maxPrice, maxPrice);
      if (b) bids.set(clubId, b);
    }
    return bids;
  }

  act(view: MarketView): void {
    view.exchange.cancelAll(this.id);
    const worth = view.netWorth(this.id);
    for (const clubId of this.rng.shuffle([...view.clubIds]).slice(0, 5)) {
      const past = view.priceDaysAgo(clubId, this.lookback);
      if (!past) continue;
      const price = view.price(clubId);
      const change = price / past - 1;
      const held = view.ledger.availableShares(this.id, clubId);
      if (change > this.threshold) {
        // Não concentra mais de 15% do patrimônio num clube só.
        const room = worth * 0.15 - held * price;
        if (room > 0) view.limit(this.id, clubId, "buy", Math.min(worth * 0.05, room) / (price * 1.01), price * 1.01);
      } else if (change < -this.threshold && held > 0) {
        view.limit(this.id, clubId, "sell", held, price * 0.99);
      }
    }
  }
}

export class FanBot extends BaseBot {
  readonly profile = "torcedor";
  private lastSeen = 0;

  constructor(
    id: string,
    rng: Rng,
    readonly club: string,
  ) {
    super(id, rng);
  }

  ipoBids(_view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    const band = bands.get(this.club)!;
    const b = this.bid((cash * 0.85) / band.max, band.max);
    return new Map(b ? [[this.club, b]] : []);
  }

  act(view: MarketView): void {
    const last = view.lastResult(this.club);
    if (!last || last.at <= this.lastSeen) return;
    this.lastSeen = last.at;
    view.exchange.cancelAll(this.id);
    const price = view.price(this.club);
    if (last.result === "W") {
      const cash = view.ledger.availableCash(this.id);
      view.limit(this.id, this.club, "buy", (cash * 0.3) / (price * 1.03), price * 1.03);
    } else if (last.result === "L" && this.rng.chance(0.3)) {
      const held = view.ledger.availableShares(this.id, this.club);
      view.limit(this.id, this.club, "sell", held * 0.1, price * 0.98);
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

  ipoBids(_view: MarketView, bands: Map<string, PriceBand>, cash: Cents): Map<string, Bid> {
    const bids = new Map<string, Bid>();
    const chosen = this.rng.shuffle([...bands.keys()]).slice(0, 8);
    const budget = (cash * 0.9) / chosen.length;
    for (const clubId of chosen) {
      const band = bands.get(clubId)!;
      const maxPrice = this.rng.uniform(band.min, band.max);
      const b = this.bid(budget / maxPrice, maxPrice);
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
      if (this.rng.chance(0.2)) {
        view.market(this.id, clubId, side, side === "sell" ? Math.min(held, quantity) : quantity);
      } else {
        view.limit(this.id, clubId, side, quantity, price * (1 + this.rng.normal(0, 0.015)));
      }
    }
  }
}
