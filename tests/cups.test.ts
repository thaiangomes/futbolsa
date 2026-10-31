import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BRASILEIRAO_A, COPA_DO_BRASIL, LIBERTADORES, scheduleCupPayouts, SULAMERICANA } from "../src/engine/dividends.js";
import { Ledger } from "../src/engine/ledger.js";
import { Exchange } from "../src/engine/orderbook.js";
import type { Match } from "../src/engine/types.js";
import { MarketView } from "../src/sim/market.js";

const jogo = (phase: string, day: string, home: string, away: string, hg: number, ag: number): Match => ({
  id: `${phase}-${day}-${home}-${away}`, competition: "libertadores", phase, kickoff: `${day}T21:30:00-03:00`,
  home, away, homeGoals: hg, awayGoals: ag, status: "finished",
});

// FLA3 passa dos grupos e é campeão; X1 cai nos grupos.
const copa = [
  jogo("grupos", "2025-04-01", "FLA3", "X1", 2, 0),
  jogo("grupos", "2025-04-02", "X2", "X3", 1, 0),
  jogo("oitavas", "2025-08-01", "FLA3", "X2", 1, 0),
  jogo("quartas", "2025-09-01", "FLA3", "X3", 1, 0),
  jogo("semifinal", "2025-10-01", "X4", "FLA3", 0, 1),
  jogo("final", "2025-11-29", "X5", "FLA3", 0, 1),
];

describe("valor esperado das copas na visão dos bots", () => {
  const ledger = new Ledger();
  const view = new MarketView(new Exchange(ledger), ledger, ["FLA3", "X1"], BRASILEIRAO_A, []);
  view.setCups([{ matches: copa, rules: LIBERTADORES }]);
  const at = (iso: string) => { view.now = Date.parse(iso); };

  it("antes dos grupos, conta metade de chance de passar de cada fase", () => {
    at("2025-03-01T00:00:00-03:00");
    // 0,5 × 150 + 0,25 × 225 + 0,125 × 375 + 0,0625 × 600 + 0,03125 × 1200
    expect(view.cupExpected("FLA3")).toBe(253);
    expect(view.cupExpected("X1")).toBe(253);
  });

  it("só sabe quem passou quando a fase termina", () => {
    at("2025-04-02T00:00:00-03:00"); // FLA3 já jogou, mas os grupos não acabaram
    expect(view.cupExpected("X1")).toBe(253);
    at("2025-04-10T00:00:00-03:00");
    expect(view.cupExpected("X1")).toBe(0);
    // Nas oitavas: 0,5 × 225 + 0,25 × 375 + 0,125 × 600 + 0,0625 × 1200
    expect(view.cupExpected("FLA3")).toBe(356);
    expect(view.nextCupMatch("FLA3")?.phase).toBe("oitavas");
  });

  it("depois da final não espera mais nada", () => {
    at("2025-12-01T00:00:00-03:00");
    expect(view.cupExpected("FLA3")).toBe(0);
    expect(view.nextCupMatch("FLA3")).toBeUndefined();
  });
});

describe("copas de 2025 nos dados", () => {
  const load = (c: string) => (JSON.parse(readFileSync(`data/${c}-2025.json`, "utf8")) as { matches: Match[] }).matches;
  const totais = (c: string, rules: typeof LIBERTADORES) => {
    const t: Record<string, number> = {};
    for (const p of scheduleCupPayouts(load(c), rules)) t[p.clubId] = (t[p.clubId] ?? 0) + p.perShare;
    return t;
  };

  it("Copa do Brasil: Corinthians campeão, entrando na 3ª fase", () => {
    const t = totais("copa-do-brasil", COPA_DO_BRASIL);
    expect(t.COR3).toBe(100 + 150 + 250 + 400 + 800);
    expect(t.VAS3).toBe(50 + 75 + 100 + 150 + 250 + 400);
  });

  it("Sul-Americana: o Fluminense, primeiro do grupo, recebe 0,60; o Atlético-MG, vice, veio pelos playoffs", () => {
    const t = totais("sul-americana", SULAMERICANA);
    expect(t.FLU3).toBe(60 + 90);
    expect(t.CAM3).toBe(30 + 30 + 90 + 150 + 240);
    expect(t.BAH3).toBeUndefined(); // veio da Libertadores e caiu nos playoffs
  });
});
