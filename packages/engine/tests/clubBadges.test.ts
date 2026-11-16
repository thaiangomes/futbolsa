import { describe, expect, it } from "vitest";
import { CLUBS } from "../src/data/clubs.js";
import { BADGE_PATTERNS, badgeAbbrOf, CLUB_BADGES } from "../src/data/clubBadges.js";

describe("selos dos clubes (item 8 da fila da partida de teste)", () => {
  it("todo clube conhecido tem selo, e nenhum selo é de clube desconhecido", () => {
    expect(Object.keys(CLUB_BADGES).sort()).toEqual(CLUBS.map((c) => c.id).sort());
  });

  it("cores em hexadecimal, padrão conhecido, e a segunda cor só no tricolor", () => {
    for (const [ticker, badge] of Object.entries(CLUB_BADGES)) {
      for (const cor of [badge.primary, badge.secondary, badge.ink]) expect(cor, ticker).toMatch(/^#[0-9A-F]{6}$/);
      expect(BADGE_PATTERNS, ticker).toContain(badge.pattern);
      if (badge.pattern === "tricolor") expect(badge.extra, ticker).toMatch(/^#[0-9A-F]{6}$/);
      else expect(badge.extra, ticker).toBeNull();
    }
  });

  it("a sigla é o começo do ticker", () => {
    expect(badgeAbbrOf("FLA3")).toBe("FLA");
    expect(badgeAbbrOf("SAO3")).toBe("SAO");
  });

  it("alguns selos aprovados, como nos protótipos", () => {
    expect(CLUB_BADGES.FLA3).toEqual({ primary: "#C8102E", secondary: "#111111", pattern: "aros-grossos", ink: "#FFFFFF", extra: null });
    expect(CLUB_BADGES.SAO3).toEqual({ primary: "#F4F4F4", secondary: "#E2231A", pattern: "tricolor", ink: "#111111", extra: "#111111" });
    expect(CLUB_BADGES.PAL3!.pattern).toBe("solido");
  });
});
