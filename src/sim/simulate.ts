import { priceBand, runBookbuilding, suggestedPrice, type Bid, type PriceBand } from "../engine/bookbuilding.js";
import { applyPayout, BRASILEIRAO_A, computeStandings, roundCloseTimes, scheduleLeaguePayouts, type LeagueRules, type Payout } from "../engine/dividends.js";
import { Ledger } from "../engine/ledger.js";
import { DEFAULT_MARKET_MAKER, MarketMaker, type MarketMakerConfig } from "../engine/marketMaker.js";
import type { Cents } from "../engine/money.js";
import { Exchange } from "../engine/orderbook.js";
import { finishTime, kickoffTime } from "../engine/types.js";
import type { SeasonFile } from "../data/season.js";
import { DividendBot, FanBot, MomentumBot, PROFILES, RandomBot, type Bot, type BotProfile } from "./bots.js";
import { MarketView } from "./market.js";
import { Rng } from "./rng.js";

/**
 * Simula uma temporada inteira: IPO por bookbuilding, negociação entre bots
 * com o formador de mercado da casa e dividendos pagos pelos resultados reais.
 */

export interface SimConfig {
  seed: number;
  bots: Record<BotProfile, number>;
  initialCash: Cents;
  /** Ações emitidas por clube para cada jogador esperado. */
  sharesPerPlayer: number;
  /** Intervalo entre rodadas de decisão dos bots, em horas. */
  stepHours: number;
  /** Chance de cada bot agir em cada passo. */
  activity: number;
  rules: LeagueRules;
  bandWidth: number;
  marketMaker: MarketMakerConfig;
}

export const DEFAULT_SIM: SimConfig = {
  seed: 1, // Só um número para os sorteios dos bots; não tem relação com o ano dos dados.
  bots: { dividendos: 25, momentum: 25, torcedor: 25, aleatorio: 25 },
  initialCash: 10_000_000, // R$ 100 mil
  sharesPerPlayer: 150,
  stepHours: 3,
  activity: 0.25,
  rules: BRASILEIRAO_A,
  bandWidth: 0.4,
  marketMaker: DEFAULT_MARKET_MAKER,
};

export const TREASURY = "tesouraria";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClubResult {
  clubId: string;
  name: string;
  ipoPosition: number;
  band: PriceBand;
  ipoPrice: Cents;
  ipoFillRatio: number;
  ipoTreasuryShares: number;
  finalPrice: Cents;
  minPrice: Cents;
  maxPrice: Cents;
  /** Dividendos pagos por ação na temporada inteira. */
  dividendsPerShare: Cents;
  finalPosition: number;
  /** Preço logo antes do pagamento da colocação final. */
  priceBeforeFinalPayout: Cents;
}

export interface Checkpoint {
  label: string;
  at: number;
  prices: Record<string, Cents>;
  /** Dividendos que ainda seriam pagos depois deste momento (com o resultado real). */
  remainingDividends: Record<string, Cents>;
}

export interface BotResult {
  id: string;
  profile: BotProfile;
  club?: string;
  finalWorth: Cents;
  dividendsReceived: Cents;
}

export interface SimResult {
  config: SimConfig;
  season: number;
  clubs: ClubResult[];
  checkpoints: Checkpoint[];
  bots: BotResult[];
  trades: { total: number; peer: number; withHouse: number; volume: Cents };
  treasury: { startCash: Cents; finalCash: Cents; finalSharesValue: Cents };
  dailyPrices: Record<string, Cents[]>;
  totalDividends: Cents;
}

export function simulate(season: SeasonFile, partial: Partial<SimConfig> = {}): SimResult {
  const config: SimConfig = { ...DEFAULT_SIM, ...partial };
  const rng = new Rng(config.seed);
  const clubIds = season.clubs.map((c) => c.id);
  const matches = [...season.matches].sort((a, b) => finishTime(a) - finishTime(b));

  const ledger = new Ledger();
  ledger.open(TREASURY, 0);
  // Com a âncora "peer" o preço volta a ser formado só pelos negócios entre
  // jogadores, como no plano original; senão o formador cotaria em volta do
  // mesmo preço do "lastTrade" e a opção não teria efeito.
  const exchange = new Exchange(ledger, {
    houseAccounts: [TREASURY],
    houseTradesSetPrice: config.marketMaker.anchor === "lastTrade",
  });
  const view = new MarketView(exchange, ledger, clubIds, config.rules, matches);
  const maker = new MarketMaker(exchange, ledger, TREASURY, config.marketMaker);

  // Bots: torcedores distribuídos pelos clubes em ordem.
  const bots: Bot[] = [];
  let fanIndex = 0;
  for (const profile of PROFILES) {
    for (let i = 0; i < config.bots[profile]; i++) {
      const id = `${profile}-${String(i + 1).padStart(2, "0")}`;
      const botRng = new Rng(Math.floor(rng.next() * 2 ** 32));
      bots.push(
        profile === "dividendos" ? new DividendBot(id, botRng)
        : profile === "momentum" ? new MomentumBot(id, botRng)
        : profile === "torcedor" ? new FanBot(id, botRng, clubIds[fanIndex++ % clubIds.length]!)
        : new RandomBot(id, botRng),
      );
      ledger.open(id, config.initialCash);
    }
  }

  // ---- IPO por bookbuilding --------------------------------------------------
  const firstKickoff = Math.min(...matches.map(kickoffTime));
  const ipoAt = firstKickoff - 7 * DAY_MS;
  exchange.setTime(ipoAt);
  view.now = ipoAt;

  const bands = new Map<string, PriceBand>(
    season.clubs.map((c) => [c.id, priceBand(suggestedPrice(c.ipoPosition), config.bandWidth)]),
  );
  const bidsByClub = new Map<string, Bid[]>(clubIds.map((id) => [id, []]));
  for (const bot of bots) {
    for (const [clubId, bid] of bot.ipoBids(view, bands, config.initialCash)) bidsByClub.get(clubId)!.push(bid);
  }
  const offer = config.sharesPerPlayer * bots.length;
  const ipo = new Map<string, ReturnType<typeof runBookbuilding>>();
  for (const clubId of clubIds) {
    const result = runBookbuilding(offer, bands.get(clubId)!, bidsByClub.get(clubId)!);
    ipo.set(clubId, result);
    for (const a of result.allocations) {
      ledger.adjustCash(a.investorId, -a.cost);
      ledger.adjustShares(a.investorId, clubId, a.quantity);
      ledger.adjustCash(TREASURY, a.cost);
    }
    ledger.adjustShares(TREASURY, clubId, result.treasuryShares);
    exchange.setReferencePrice(clubId, result.price);
  }
  const treasuryStartCash = ledger.get(TREASURY).cash;

  // ---- Temporada -------------------------------------------------------------
  const payouts: Payout[] = scheduleLeaguePayouts(matches, config.rules);
  const closes = [...roundCloseTimes(matches)].sort((a, b) => a[1] - b[1]);
  const lastPayoutAt = Math.max(...payouts.map((p) => p.at));
  const finalPayoutAt = Math.max(...payouts.filter((p) => p.kind === "placement").map((p) => p.at), lastPayoutAt);
  const end = lastPayoutAt + DAY_MS;
  const step = config.stepHours * 60 * 60 * 1000;

  const remainingAfter = (t: number): Record<string, Cents> => {
    const out: Record<string, Cents> = Object.fromEntries(clubIds.map((id) => [id, 0]));
    for (const p of payouts) if (p.at > t) out[p.clubId] = out[p.clubId]! + p.perShare;
    return out;
  };
  const pricesNow = () => Object.fromEntries(clubIds.map((id) => [id, view.price(id)]));
  const checkpoints: Checkpoint[] = [
    { label: "IPO", at: ipoAt, prices: pricesNow(), remainingDividends: remainingAfter(ipoAt) },
  ];

  const dividendsPerShare = new Map(clubIds.map((id) => [id, 0]));
  const botDividends = new Map(bots.map((b) => [b.id, 0]));
  const minMax = new Map(clubIds.map((id) => [id, { min: view.price(id), max: view.price(id) }]));
  const priceBeforeFinal = new Map<string, Cents>();
  const exclude = new Set([TREASURY]);
  let totalDividends = 0;

  let trades = 0;
  let peerTrades = 0;
  let volume = 0;
  exchange.onTrade((t) => {
    trades++;
    volume += t.price * t.quantity;
    if (t.buyerId !== TREASURY && t.sellerId !== TREASURY) peerTrades++;
  });

  let payoutIdx = 0;
  let matchIdx = 0;
  let closeIdx = 0;
  let lastDay = Math.floor(ipoAt / DAY_MS);

  for (let t = ipoAt + DAY_MS; t <= end; t += step) {
    exchange.setTime(t);
    view.now = t;

    // Dividendos com data até agora, pagos a quem tem a ação neste momento.
    while (payoutIdx < payouts.length && payouts[payoutIdx]!.at <= t) {
      const p = payouts[payoutIdx++]!;
      if (p.at === finalPayoutAt && p.kind === "placement" && !priceBeforeFinal.size) {
        for (const id of clubIds) priceBeforeFinal.set(id, view.price(id));
      }
      for (const bot of bots) {
        const shares = ledger.shares(bot.id, p.clubId);
        botDividends.set(bot.id, botDividends.get(bot.id)! + shares * p.perShare);
      }
      totalDividends += applyPayout(ledger, p, exclude);
      dividendsPerShare.set(p.clubId, dividendsPerShare.get(p.clubId)! + p.perShare);
      if (p.kind === "points") {
        view.paidPoints.set(p.clubId, view.paidPoints.get(p.clubId)! + p.perShare / config.rules.perPoint);
      } else if (p.kind === "placement") {
        view.placementPaid = true;
      }
    }

    // Resultados que já saíram.
    let advanced = false;
    while (matchIdx < matches.length && finishTime(matches[matchIdx]!) <= t) {
      matchIdx++;
      advanced = true;
    }
    if (advanced) view.setKnownMatches(matches.slice(0, matchIdx).filter((m) => m.status === "finished"));

    // Fotografia a cada rodada fechada.
    while (closeIdx < closes.length && closes[closeIdx]![1] <= t) {
      const [round, at] = closes[closeIdx++]!;
      checkpoints.push({ label: `Rodada ${round}`, at, prices: pricesNow(), remainingDividends: remainingAfter(at) });
    }

    // Formador de mercado: spread maior para quem está em campo agora.
    const inMatch = new Set<string>();
    for (const m of matches) {
      const k = kickoffTime(m);
      if (k <= t && t < finishTime(m)) {
        inMatch.add(m.home);
        inMatch.add(m.away);
      }
    }
    for (const clubId of clubIds) maker.refresh(clubId, inMatch.has(clubId));

    for (const bot of rng.shuffle([...bots])) {
      if (rng.chance(config.activity)) bot.act(view);
    }

    for (const clubId of clubIds) {
      const p = view.price(clubId);
      const mm = minMax.get(clubId)!;
      mm.min = Math.min(mm.min, p);
      mm.max = Math.max(mm.max, p);
    }
    const day = Math.floor(t / DAY_MS);
    if (day !== lastDay) {
      lastDay = day;
      for (const clubId of clubIds) view.history.get(clubId)!.push(view.price(clubId));
    }
  }

  checkpoints.push({ label: "Fim", at: end, prices: pricesNow(), remainingDividends: remainingAfter(end) });

  const finalTable = new Map(computeStandings(matches).map((r, i) => [r.clubId, i + 1]));

  const treasury = ledger.get(TREASURY);
  let treasurySharesValue = 0;
  for (const [clubId, p] of treasury.positions) treasurySharesValue += p.shares * view.price(clubId);

  return {
    config,
    season: season.season,
    clubs: season.clubs.map((c) => {
      const r = ipo.get(c.id)!;
      return {
        clubId: c.id,
        name: c.name,
        ipoPosition: c.ipoPosition,
        band: bands.get(c.id)!,
        ipoPrice: r.price,
        ipoFillRatio: r.fillRatio,
        ipoTreasuryShares: r.treasuryShares,
        finalPrice: view.price(c.id),
        minPrice: minMax.get(c.id)!.min,
        maxPrice: minMax.get(c.id)!.max,
        dividendsPerShare: dividendsPerShare.get(c.id)!,
        finalPosition: finalTable.get(c.id)!,
        priceBeforeFinalPayout: priceBeforeFinal.get(c.id) ?? view.price(c.id),
      };
    }),
    checkpoints,
    bots: bots.map((b) => ({
      id: b.id,
      profile: b.profile,
      club: b instanceof FanBot ? b.club : undefined,
      finalWorth: view.netWorth(b.id),
      dividendsReceived: botDividends.get(b.id)!,
    })),
    trades: { total: trades, peer: peerTrades, withHouse: trades - peerTrades, volume },
    treasury: { startCash: treasuryStartCash, finalCash: treasury.cash, finalSharesValue: treasurySharesValue },
    dailyPrices: Object.fromEntries(view.history),
    totalDividends,
  };
}
