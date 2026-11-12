import { describe, expect, it } from "vitest";
import { portfolioSlices } from "../src/engine/slices.js";
import { reais } from "../src/engine/money.js";

const sum = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);

describe("fatias da foto mensal", () => {
  it("carteira 30: R$ 47.500 em ações e R$ 52.500 de caixa dão 47,5% e 52,5%", () => {
    expect(portfolioSlices({ cash: reais(52_500), positions: [{ ticker: "FLA3", value: reais(47_500) }] })).toEqual({ FLA3: 475, cash: 525 });
  });

  it("carteira 41: o a receber não entra na base (as fatias não mudam)", () => {
    // a função nem recebe o a receber; o mesmo par de valores dá as mesmas fatias
    const slices = portfolioSlices({ cash: reais(52_500), positions: [{ ticker: "FLA3", value: reais(47_500) }] });
    expect(sum(slices)).toBe(1000);
  });

  it("a maior sobra reparte o que falta e as fatias somam sempre 1.000 (sorteio)", () => {
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let i = 0; i < 500; i++) {
      const n = 1 + Math.floor(next() * 6);
      const positions = Array.from({ length: n }, (_, k) => ({ ticker: `C${k}`, value: Math.floor(next() * 5_000_000) }));
      const cash = Math.floor(next() * 5_000_000) - 1_000_000;
      const slices = portfolioSlices({ cash, positions });
      const base = cash + positions.reduce((a, p) => a + p.value, 0);
      if (base <= 0) expect(slices).toEqual({});
      else expect(sum(slices)).toBe(1000);
    }
  });

  it("três fatias iguais: 333, 333 e 334, com o empate decidido de forma estável", () => {
    const input = { cash: 100, positions: [{ ticker: "AAA", value: 100 }, { ticker: "BBB", value: 100 }] };
    const first = portfolioSlices(input);
    expect(first).toEqual(portfolioSlices(input));
    expect(Object.values(first).sort()).toEqual([333, 333, 334]);
  });

  it("caixa negativo vira fatia negativa e o total continua 1.000", () => {
    const slices = portfolioSlices({ cash: -25_000, positions: [{ ticker: "FLA3", value: 100_000 }] });
    expect(slices.cash).toBeLessThan(0);
    expect(sum(slices)).toBe(1000);
    expect(slices).toEqual({ cash: -333, FLA3: 1333 });
  });

  it("base zero ou negativa devolve vazio", () => {
    expect(portfolioSlices({ cash: 0, positions: [] })).toEqual({});
    expect(portfolioSlices({ cash: -100, positions: [{ ticker: "FLA3", value: 100 }] })).toEqual({});
    expect(portfolioSlices({ cash: -500, positions: [{ ticker: "FLA3", value: 100 }] })).toEqual({});
  });

  it("só caixa vira 100% de caixa e fatia zerada não entra", () => {
    expect(portfolioSlices({ cash: 1000, positions: [{ ticker: "FLA3", value: 0 }] })).toEqual({ cash: 1000 });
  });
});
