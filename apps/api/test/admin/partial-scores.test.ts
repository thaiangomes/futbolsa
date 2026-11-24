import { describe, expect, it } from "vitest";
import { liveWithEngineIds } from "../../src/modules/admin/bots/partial-scores.js";
import { normalizeClubName } from "../../src/modules/admin/results/club-resolver.js";

describe("placar ao vivo das copas", () => {
  const clubs = [
    { id: 1, ticker: "PAL3", name: "Palmeiras" },
    { id: 90, ticker: null, name: "EXT-THE-STRONGEST" },
    { id: 91, ticker: null, name: "The Strongest FC" },
  ];
  const parcial = { homeGoals: 1, awayGoals: 0, minute: 30 };

  it("o clube não listado do jogo ao vivo vira o EXT-<id> do banco, e o listado fica pelo ticker", () => {
    const [m] = liveWithEngineIds([{ home: "PAL3", away: "EXT-THE-STRONGEST", ...parcial }], clubs, normalizeClubName);
    expect(m).toEqual({ home: "PAL3", away: "EXT-90", ...parcial });
  });

  it("o nome sem sufixo de tipo de clube também acha o clube; nome desconhecido fica como veio", () => {
    const [a, b] = liveWithEngineIds(
      [{ home: "The Strongest", away: "PAL3", ...parcial }, { home: "PAL3", away: "EXT-NINGUEM", ...parcial }],
      clubs.slice(0, 1).concat({ id: 91, ticker: null, name: "The Strongest FC" }),
      normalizeClubName,
    );
    expect(a).toEqual({ home: "EXT-91", away: "PAL3", ...parcial });
    expect(b).toEqual({ home: "PAL3", away: "EXT-NINGUEM", ...parcial });
  });
});
