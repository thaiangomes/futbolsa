import { describe, expect, it } from "vitest";
import { loadSeason, markOutOfWindow } from "../src/data/season.js";
import { DEFAULT_MARKET_MAKER } from "../src/engine/marketMaker.js";
import type { Match } from "../src/engine/types.js";
import { simulate, TREASURY } from "../src/sim/simulate.js";

const season = loadSeason("tests/fixtures/mini-season.json");
const small = { bots: { dividendos: 2, momentum: 2, torcedor: 4, aleatorio: 2 }, stepHours: 6 };

describe("simulação com o fixture de exemplo", () => {
  const result = simulate(season, small);

  it("faz IPO de todos os clubes dentro da faixa", () => {
    expect(result.clubs).toHaveLength(4);
    for (const c of result.clubs) {
      expect(c.ipoPrice).toBeGreaterThanOrEqual(c.band.min);
      expect(c.ipoPrice).toBeLessThanOrEqual(c.band.max);
    }
  });

  it("paga os dividendos do campeonato (0,10 por ponto + colocação)", () => {
    const fla = result.clubs.find((c) => c.clubId === "FLA3")!;
    // FLA3: 3V 2E 1D = 11 pontos → R$ 1,10, e 1º lugar → R$ 5,00.
    expect(fla.finalPosition).toBe(1);
    expect(fla.dividendsPerShare).toBe(110 + 500);
  });

  it("é reproduzível com a mesma semente", () => {
    const again = simulate(season, small);
    expect(again.clubs.map((c) => c.finalPrice)).toEqual(result.clubs.map((c) => c.finalPrice));
    expect(again.bots.map((b) => b.finalWorth)).toEqual(result.bots.map((b) => b.finalWorth));
  });

  it("a âncora peer muda o resultado (só negócios entre bots formam o preço)", () => {
    const peer = simulate(season, { ...small, marketMaker: { ...DEFAULT_MARKET_MAKER, anchor: "peer" } });
    expect(peer.clubs.map((c) => c.finalPrice)).not.toEqual(result.clubs.map((c) => c.finalPrice));
  });

  it("ninguém termina com patrimônio negativo e a tesouraria não recebe dividendos", () => {
    for (const b of result.bots) expect(b.finalWorth).toBeGreaterThan(0);
    expect(result.bots.find((b) => b.id === TREASURY)).toBeUndefined();
    const paid = result.bots.reduce((s, b) => s + b.dividendsReceived, 0);
    expect(paid).toBe(result.totalDividends);
  });
});

describe("markOutOfWindow", () => {
  const m = (id: string, round: number, day: string): Match => ({
    id, competition: "brasileirao-a", round, kickoff: `${day}T16:00:00-03:00`,
    home: "A", away: "B", homeGoals: 0, awayGoals: 0, status: "finished",
  });

  it("marca como adiado o jogo disputado longe da data da rodada", () => {
    const out = markOutOfWindow([m("1", 12, "2025-06-12"), m("2", 12, "2025-06-13"), m("3", 12, "2025-11-15")]);
    expect(out.map((x) => x.postponed ?? false)).toEqual([false, false, true]);
  });
});
