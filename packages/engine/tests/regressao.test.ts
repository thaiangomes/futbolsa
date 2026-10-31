import { describe, expect, it } from "vitest";
import { fingerprint, readReference, SCENARIOS } from "../src/sim/regressao.js";
import { simulate } from "../src/sim/simulate.js";
import { loadSeason } from "../src/data/season.js";

// R1: a simulação dá os mesmos negócios e o mesmo resultado com a mesma semente.
// Os cenários do Brasileirão 2025 (mais de um minuto cada) rodam no `npm run sim:regressao`.
describe("regressão da simulação", () => {
  for (const s of SCENARIOS.filter((s) => !s.slow)) {
    it(`R1: ${s.name} igual à referência`, () => {
      expect(fingerprint(s.name, s.run)).toEqual(readReference(s.name));
    });
  }

  it("R1: a impressão digital pega a mudança de semente", () => {
    const fast = SCENARIOS.find((s) => s.name === "A-mini-fair")!;
    const other = fingerprint(fast.name, (onTrade) =>
      simulate(loadSeason("tests/fixtures/mini-season.json"), { bots: { dividendos: 2, momentum: 2, torcedor: 4, aleatorio: 2, trader: 3, captura: 2, analista: 2, concentrador: 2, antecipador: 2 }, buyback: 1.5, seed: 2 }, { onTrade }),
    );
    expect(other.tradesSha256).not.toBe(readReference(fast.name).tradesSha256);
  });
});
