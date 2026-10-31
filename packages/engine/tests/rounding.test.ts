import { describe, expect, it } from "vitest";
import { mulDivRound } from "../src/engine/rounding.js";

describe("mulDivRound", () => {
  it("arredonda meio centavo para cima (dividendos 18: R$ 5,55 × 1,5 = R$ 8,33)", () => {
    expect(mulDivRound(555, 15_000, 10_000)).toBe(833);
  });

  it("arredonda meio centavo para cima (dividendos 23: R$ 4,75 × 1,5 = R$ 7,13)", () => {
    expect(mulDivRound(475, 15_000, 10_000)).toBe(713);
  });

  it("não mexe em divisão exata (dividendos 17: R$ 39,40 × 1,5 = R$ 59,10)", () => {
    expect(mulDivRound(3_940, 15_000, 10_000)).toBe(5_910);
  });

  it("arredonda para baixo abaixo da metade e para cima acima dela", () => {
    expect(mulDivRound(10, 1, 3)).toBe(3); // 3,33
    expect(mulDivRound(20, 1, 3)).toBe(7); // 6,67
  });

  it("zero vezes qualquer coisa é zero", () => {
    expect(mulDivRound(0, 12_345, 7)).toBe(0);
    expect(mulDivRound(12_345, 0, 7)).toBe(0);
  });

  it("não perde precisão quando o produto passa de 2^53", () => {
    // 9×10^12 × 3×10^6 = 2,7×10^19: em ponto flutuante já erraria.
    expect(mulDivRound(9_000_000_000_000, 3_000_000, 3_000_000)).toBe(9_000_000_000_000);
    expect(mulDivRound(9_000_000_000_001, 2, 4)).toBe(4_500_000_000_001); // 4.500.000.000.000,5 sobe
  });

  it("recusa negativo, não inteiro e divisor zero", () => {
    expect(() => mulDivRound(-1, 1, 1)).toThrow();
    expect(() => mulDivRound(1, -1, 1)).toThrow();
    expect(() => mulDivRound(1.5, 1, 1)).toThrow();
    expect(() => mulDivRound(1, 1, 0)).toThrow();
    expect(() => mulDivRound(1, 1, -2)).toThrow();
  });

  it("recusa resultado que não cabe num inteiro seguro", () => {
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });
});
