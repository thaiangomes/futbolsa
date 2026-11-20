import { describe, expect, it } from "vitest";
import { loadSeason } from "../src/data/season.js";
import { BRASILEIRAO_A_2026 as BRASILEIRAO_A, computeStandings, roundCloseTimes, scheduleCupPayouts, scheduleLeaguePayouts } from "../src/engine/dividends.js";
import { fairValue, projectLeague } from "../src/engine/fairValue.js";
import { Ledger } from "../src/engine/ledger.js";
import { Exchange } from "../src/engine/orderbook.js";
import { finishTime, kickoffTime } from "../src/engine/types.js";
import { MarketView } from "../src/sim/market.js";
import { defaultRunConfig } from "../src/sim/regressao.js";
import { LegacyMarketView } from "./support/legado/market.js";

// J1 e J2 do Plano do núcleo de casamento: o valor justo e as copas esperadas
// no motor dão os mesmos números da Fase 0, e o valor justo cai no fechamento.

describe("valor justo no motor", () => {
  it("J1: em todo passo de 3 horas da temporada 2025 com as três copas, os números são os da Fase 0", () => {
    const season = loadSeason("data/brasileirao-2025.json");
    const { cups } = defaultRunConfig(1);
    const clubIds = season.clubs.map((c) => c.id);
    const matches = [...season.matches].sort((a, b) => finishTime(a) - finishTime(b));
    const make = <V extends MarketView | LegacyMarketView>(View: new (...a: ConstructorParameters<typeof MarketView>) => V) => {
      const ledger = new Ledger();
      const view = new View(new Exchange(ledger), ledger, clubIds, BRASILEIRAO_A, matches);
      view.buybackMultiple = 1.5;
      view.setCups(cups!);
      return view;
    };
    const now = make(MarketView);
    const old = make(LegacyMarketView);

    const payouts = [
      ...scheduleLeaguePayouts(matches, BRASILEIRAO_A),
      ...cups!.flatMap((c) => scheduleCupPayouts(c.matches, c.rules)).filter((p) => clubIds.includes(p.clubId)),
    ].sort((a, b) => a.at - b.at);
    const start = Math.min(...matches.map(kickoffTime)) - 7 * 86_400_000;
    const end = Math.max(...payouts.map((p) => p.at)) + 86_400_000;
    const analyst = (id: string) => 1 + (id.charCodeAt(0) % 7) / 10; // um palpite qualquer, igual nos dois
    let pi = 0;
    let mi = 0;
    let steps = 0;
    for (let t = start; t <= end; t += 3 * 3_600_000) {
      now.now = old.now = t;
      while (pi < payouts.length && payouts[pi]!.at <= t) {
        const p = payouts[pi++]!;
        for (const v of [now, old]) {
          if (p.kind === "points") v.paidPoints.set(p.clubId, v.paidPoints.get(p.clubId)! + p.perShare / BRASILEIRAO_A.perPoint);
          else if (p.kind === "placement") v.placementPaid = true;
          else v.cupPaid.set(p.clubId, (v.cupPaid.get(p.clubId) ?? 0) + p.perShare);
        }
      }
      let advanced = false;
      while (mi < matches.length && finishTime(matches[mi]!) <= t) {
        mi++;
        advanced = true;
      }
      if (advanced) {
        const known = matches.slice(0, mi).filter((m) => m.status === "finished");
        now.setKnownMatches(known);
        old.setKnownMatches(known);
      }
      for (const id of clubIds) {
        // Um expect por comparação deixaria o teste lento; só chama quando difere.
        const a = [now.fairValue(id), now.cupExpected(id), now.fairValueWith(id, analyst), now.nextCupMatch(id)];
        const b = [old.fairValue(id), old.cupExpected(id), old.fairValueWith(id, analyst), old.nextCupMatch(id)];
        if (a.some((x, k) => x !== b[k])) expect({ t, id, a }).toEqual({ t, id, a: b });
      }
      steps++;
    }
    expect(steps).toBeGreaterThan(2000);
  }, 60_000);

  it("livro 28 (J2): o valor justo cai exatamente o dividendo da rodada no fechamento dela", () => {
    const season = loadSeason("tests/fixtures/mini-season.json");
    const clubIds = season.clubs.map((c) => c.id);
    const matches = [...season.matches].sort((a, b) => finishTime(a) - finishTime(b));
    const closes = [...roundCloseTimes(matches)].sort((a, b) => a[1] - b[1]);
    const [round, closeAt] = closes[1]!; // a segunda rodada
    const known = matches.filter((m) => m.status === "finished" && finishTime(m) <= closeAt);
    const projection = projectLeague(known, clubIds, (2 * matches.length) / clubIds.length);
    const fla = computeStandings(known).find((r) => r.clubId === "FLA3")!;
    const roundPoints = scheduleLeaguePayouts(matches, BRASILEIRAO_A).filter((p) => p.kind === "points" && p.clubId === "FLA3" && p.at === closeAt)
      .reduce((s, p) => s + p.perShare / BRASILEIRAO_A.perPoint, 0);
    expect(roundPoints).toBeGreaterThan(0);
    const input = (closedPoints: number) => ({
      projection,
      clubId: "FLA3",
      rules: BRASILEIRAO_A,
      buybackMultiple: 1.5,
      closedPoints,
      placementClosed: false,
      cupClosed: 0,
      cupExpected: 0,
    });
    // Um instante antes do fechamento da rodada, os pontos dela ainda não fecharam; no fechamento, sim.
    const before = fairValue(input(fla.points - roundPoints));
    const atClose = fairValue(input(fla.points));
    expect(before - atClose).toBe(roundPoints * BRASILEIRAO_A.perPoint);
    expect(round).toBeGreaterThan(0);
  });
});
