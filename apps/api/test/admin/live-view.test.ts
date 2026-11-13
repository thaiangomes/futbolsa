import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BRASILEIRAO_A,
  createBot,
  Exchange,
  finishTime,

  Ledger,
  LeagueView,
  MarketView,
  PROFILES,
  Rng,
  type Cents,
  type Match,
} from "@futbolsa/engine";
import { LiveBotView, type BotSnapshot, type BotWalletState } from "../../src/modules/admin/bots/live-view.js";

// F14, T11: com o mesmo estado (jogos, preços, carteiras), a visão ao vivo e a `MarketView` da simulação dão o mesmo
// valor justo, a mesma colocação e as mesmas intenções de cada perfil. A visão não abre transação nem trava nada: nem
// tem banco.

const file = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../packages/engine/data/brasileirao-2025.json", import.meta.url)), "utf8"),
) as { clubs: Array<{ id: string; ipoPosition: number }>; matches: Match[] };

const clubIds = file.clubs.map((c) => c.id);
const NOW = Date.parse("2025-09-01T12:00:00Z");
const finished = file.matches.filter((m) => m.status === "finished" && finishTime(m) <= NOW).sort((a, b) => finishTime(a) - finishTime(b));

/** Um preço diferente para cada clube, determinístico. */
const priceOf = (i: number): Cents => 2000 + ((i * 337) % 4000);
const prices = new Map(clubIds.map((id, i) => [id, priceOf(i)]));
const closes = new Map(clubIds.map((id, i) => [id, [priceOf(i) - 90, priceOf(i) - 60, priceOf(i) - 30, priceOf(i)]]));

class FixedPriceMarket extends MarketView {
  override price(clubId: string): Cents {
    return prices.get(clubId)!;
  }
}

function build(botIds: string[]) {
  const ledger = new Ledger();
  const exchange = new Exchange(ledger, {});
  const sim = new FixedPriceMarket(exchange, ledger, clubIds, BRASILEIRAO_A, file.matches);
  sim.buybackMultiple = 1.5;
  sim.now = NOW;
  sim.setKnownMatches(finished);
  for (const [id, c] of closes) sim.history.set(id, [...c]);

  const league = new LeagueView(clubIds, BRASILEIRAO_A, file.matches);
  league.buybackMultiple = 1.5;
  league.now = NOW;
  league.setKnownMatches(finished);

  const wallets = new Map<string, BotWalletState>();
  botIds.forEach((id, n) => {
    ledger.open(id, 5_000_000);
    const state: BotWalletState = { cash: 5_000_000, reservedCash: 0, positions: new Map() };
    // cada bot tem ações de 3 clubes
    for (let k = 0; k < 3; k++) {
      const club = clubIds[(n * 3 + k) % clubIds.length]!;
      ledger.adjustShares(id, club, 40 + k * 10);
      state.positions.set(club, { shares: 40 + k * 10, reservedShares: 0 });
    }
    wallets.set(id, state);
  });
  const snapshot: BotSnapshot = { now: NOW, clubIds, prices, dailyCloses: closes, leagues: new Map(clubIds.map((id) => [id, league])), wallets };
  return { sim, live: new LiveBotView(snapshot), exchange };
}

describe("LiveBotView e MarketView: o mesmo estado dá as mesmas contas", () => {
  it("valor justo, colocação, vantagem, sequência, dividendo a pagar, patrimônio e saldos são iguais", () => {
    const { sim, live } = build(["bot-1"]);
    for (const id of clubIds) {
      expect(live.fairValue(id), `fairValue ${id}`).toBe(sim.fairValue(id));
      expect(live.fairValueWith(id, () => 1.7), `fairValueWith ${id}`).toBe(sim.fairValueWith(id, () => 1.7));
      expect(live.standing(id), `standing ${id}`).toEqual(sim.standing(id));
      expect(live.winStreak(id)).toBe(sim.winStreak(id));
      expect(live.lastResult(id)).toEqual(sim.lastResult(id));
      expect(live.unpaidDividend(id)).toBe(sim.unpaidDividend(id));
      expect(live.price(id)).toBe(sim.price(id));
      expect(live.priceDaysAgo(id, 3)).toBe(sim.priceDaysAgo(id, 3));
      const next = sim.nextMatch(id);
      expect(live.nextMatch(id)).toEqual(next);
      if (next) expect(live.matchEdge(id, next)).toBe(sim.matchEdge(id, next));
      expect(live.availableShares("bot-1", id)).toBe(sim.availableShares("bot-1", id));
    }
    expect(live.netWorth("bot-1")).toBe(sim.netWorth("bot-1"));
    expect(live.availableCash("bot-1")).toBe(sim.availableCash("bot-1"));
  });

  it("o mesmo bot e a mesma semente decidem as mesmas ordens em cada um dos 9 perfis", () => {
    for (const profile of PROFILES) {
      const id = `${profile}-01`;
      const { sim, live, exchange } = build([id]);
      const options = { fanClubId: clubIds[4]!, lastYear: new Map(file.clubs.map((c) => [c.id, c.ipoPosition])), traderHitRate: 0.5 };
      const botSim = createBot(profile, id, new Rng(7), options);
      const botLive = createBot(profile, id, new Rng(7), options);
      // várias rodadas seguidas, com o instante andando: o estado interno do bot (apostas, empolgação) também bate
      for (let round = 0; round < 6; round++) {
        sim.now = NOW + round * 3 * 3600_000;
        (live as { now: number }).now = sim.now;
        const before = live.intents.length;
        botSim.act(sim);
        botLive.act(live);
        const simOrders = exchange
          .openOrders(id)
          .map((o) => ({ ticker: o.clubId, side: o.side, quantity: o.remaining, limitPrice: o.limitPrice }))
          .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.side.localeCompare(b.side) || a.quantity - b.quantity);
        // o que a visão ao vivo deixou de aberto: o que veio depois do último cancelAll
        const fresh = live.intents.slice(before);
        const lastCancel = fresh.map((i) => i.kind).lastIndexOf("cancelAll");
        const liveOrders = fresh
          .slice(lastCancel + 1)
          .flatMap((i) => (i.kind === "limit" ? [{ ticker: i.ticker, side: i.side, quantity: i.quantity, limitPrice: i.limitPrice }] : []))
          .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.side.localeCompare(b.side) || a.quantity - b.quantity);
        expect(liveOrders, `${profile} rodada ${round}`).toEqual(simOrders);
      }
    }
  });

  it("as ordens não passam de caixa nem de ações livres, e a visão guarda a reserva para o bot não prometer duas vezes", () => {
    const { live } = build(["bot-1"]);
    const club = [...(live as unknown as { snapshot: BotSnapshot }).snapshot.wallets.get("bot-1")!.positions.keys()][0]!;
    live.limit("bot-1", club, "sell", 1_000_000, 3000);
    live.limit("bot-1", club, "sell", 1, 3000);
    expect(live.intents).toHaveLength(1);
    expect(live.intents[0]).toMatchObject({ kind: "limit", side: "sell", quantity: 40 });
    expect(live.availableShares("bot-1", club)).toBe(0);
    live.limit("bot-1", clubIds[19]!, "buy", 1_000_000, 100);
    expect(live.availableCash("bot-1")).toBeGreaterThanOrEqual(0);
    live.cancelAll("bot-1");
    expect(live.availableShares("bot-1", club)).toBe(40);
    expect(live.availableCash("bot-1")).toBe(5_000_000);
  });
});
