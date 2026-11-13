import { describe, expect, it } from "vitest";
import type { Bid } from "../src/engine/bookbuilding.js";
import type { Cents } from "../src/engine/money.js";
import type { BotView } from "../src/sim/botView.js";
import { createBot, PROFILES } from "../src/sim/bots.js";
import { Rng } from "../src/sim/rng.js";

/**
 * Uma `BotView` falsa com só o que a interface tem: se um perfil usar qualquer outra coisa do mercado (o `Exchange`,
 * o `Ledger`, a `MarketView` da simulação), ele quebra aqui, porque a visão falsa não tem esses campos.
 */
class FakeView implements BotView {
  now = 1_000_000_000;
  clubIds = ["AAA3", "BBB3", "CCC3"];
  cupHype = false;
  readonly intents: string[] = [];
  price = (): Cents => 4000;
  priceDaysAgo = (_c: string, days: number): Cents => 4000 - days * 10;
  fairValue = (c: string): Cents => (c === "AAA3" ? 6000 : 4500);
  fairValueWith = (c: string): Cents => this.fairValue(c);
  unpaidDividend = (): Cents => 50;
  standing = () => undefined;
  winStreak = () => 3;
  lastResult = () => ({ result: "W" as const, at: this.now - 86_400_000 });
  nextMatch = () => undefined;
  nextCupMatch = () => undefined;
  matchEdge = () => 0.5;
  netWorth = (): Cents => 10_000_000;
  availableCash = (): Cents => 5_000_000;
  availableShares = (): number => 10;
  cashOf = (): Cents => 5_000_000;
  limit(id: string, clubId: string, side: string, q: number, price: number) {
    this.intents.push(`limit ${id} ${clubId} ${side} ${Math.floor(q)} ${Math.round(price)}`);
  }
  market(id: string, clubId: string, side: string, q: number) {
    this.intents.push(`market ${id} ${clubId} ${side} ${Math.floor(q)}`);
  }
  cancelAll(id: string) {
    this.intents.push(`cancelAll ${id}`);
  }
}

describe("BotView: a visão dos bots como interface", () => {
  it("cada um dos 9 perfis decide só com o que a interface tem, e do mesmo jeito com a mesma semente", () => {
    const bands = new Map([
      ["AAA3", { min: 3000, center: 4500, max: 6000 }],
      ["BBB3", { min: 3000, center: 4500, max: 6000 }],
      ["CCC3", { min: 3000, center: 4500, max: 6000 }],
    ]);
    for (const profile of PROFILES) {
      const run = () => {
        const view = new FakeView();
        const bot = createBot(profile, `${profile}-01`, new Rng(42), { fanClubId: "AAA3", lastYear: new Map([["AAA3", 1], ["BBB3", 10], ["CCC3", 19]]) });
        const bids: Bid[] = [...bot.ipoBids(view, bands, 10_000_000).values()];
        bot.act(view);
        return { bids, intents: view.intents };
      };
      const first = run();
      expect(first.intents.length, `${profile} faz alguma coisa`).toBeGreaterThan(0);
      expect(run(), `${profile} repete com a mesma semente`).toEqual(first);
    }
  });

  it("o torcedor precisa do clube dele", () => {
    expect(() => createBot("torcedor", "t-01", new Rng(1))).toThrow(/clube/);
  });
});
