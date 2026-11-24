import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Cents } from "@futbolsa/engine";
import { DB, type Database } from "../../../infra/db/index.js";
import { bots, candles, clubs, positions, seasonClubs, wallets } from "../../../infra/db/schema/index.js";
import { FairValueService } from "../../market/maker/fair-value.service.js";
import { leagueViewsAt } from "../../market/maker/fair-value.js";
import { displayedPriceOf } from "../../market/state/displayed-price.js";
import type { BotSnapshot, BotWalletState } from "./live-view.js";
import { liveWithEngineIds, PartialScores } from "./partial-scores.js";
import { normalizeClubName } from "../results/club-resolver.js";

/**
 * A leitura do mercado para uma rodada da tarefa dos bots (F14, T11): uma vez por rodada, sem transação aberta e sem
 * trava (as ordens dos bots só mudam o banco depois, pelo `placeOrder`). Preços exibidos, fechamentos diários, o
 * campeonato (mesma foto do valor justo da casa) e as carteiras dos bots ativos.
 */
@Injectable()
export class BotSnapshotService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly fairValues: FairValueService,
    private readonly partials: PartialScores,
  ) {}

  async load(seasonId: number, now: Date): Promise<BotSnapshot> {
    const data = await this.fairValues.load(seasonId, this.db);
    const leagues = leagueViewsAt(data, now.getTime());
    // jogos em andamento: só os bots enxergam o placar parcial (o valor justo da casa e os dividendos não mudam)
    const rawLive = this.partials.at(now);
    const live = rawLive.length > 0 ? liveWithEngineIds(rawLive, await this.db.select({ id: clubs.id, ticker: clubs.ticker, name: clubs.name }).from(clubs), normalizeClubName) : rawLive;
    if (live.length > 0) for (const view of new Set(leagues.values())) view.setLive(live);

    const clubRows = await this.db
      .select({ id: seasonClubs.clubId, ticker: clubs.ticker, lastPrice: seasonClubs.lastPrice, ipoPrice: seasonClubs.ipoPrice })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, seasonId))
      .orderBy(asc(clubs.ticker));
    const tickerOf = new Map(clubRows.map((c) => [c.id, c.ticker!]));
    const prices = new Map<string, Cents>();
    for (const c of clubRows) {
      if (c.lastPrice !== null || c.ipoPrice !== null) prices.set(c.ticker!, displayedPriceOf(c));
    }

    const closes = new Map<string, Cents[]>();
    const candleRows = await this.db
      .select({ clubId: candles.clubId, close: candles.close })
      .from(candles)
      .where(and(eq(candles.interval, "1d"), inArray(candles.clubId, [...tickerOf.keys()])))
      .orderBy(asc(candles.clubId), asc(candles.start));
    for (const r of candleRows) {
      const t = tickerOf.get(r.clubId);
      if (!t) continue;
      const list = closes.get(t) ?? [];
      list.push(r.close);
      closes.set(t, list);
    }

    const botWallets = await this.db
      .select({ id: wallets.id, botId: wallets.botId, cash: wallets.cash, reservedCash: wallets.reservedCash })
      .from(wallets)
      .innerJoin(bots, eq(bots.id, wallets.botId))
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "bot"), eq(bots.active, true)));
    const states = new Map<string, BotWalletState>();
    const byWallet = new Map<number, BotWalletState>();
    for (const w of botWallets) {
      const state: BotWalletState = { cash: w.cash, reservedCash: w.reservedCash, positions: new Map() };
      states.set(String(w.botId), state);
      byWallet.set(w.id, state);
    }
    if (byWallet.size > 0) {
      const held = await this.db
        .select({ walletId: positions.walletId, clubId: positions.clubId, shares: positions.shares, reservedShares: positions.reservedShares })
        .from(positions)
        .where(inArray(positions.walletId, [...byWallet.keys()]));
      for (const p of held) {
        const t = tickerOf.get(p.clubId);
        if (t && p.shares > 0) byWallet.get(p.walletId)!.positions.set(t, { shares: p.shares, reservedShares: p.reservedShares });
      }
    }

    return {
      now: now.getTime(),
      clubIds: [...tickerOf.values()].filter((t) => leagues.has(t)),
      prices,
      dailyCloses: closes,
      leagues,
      wallets: states,
    };
  }
}
