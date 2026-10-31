import { describe, expect, it } from "vitest";
import { indexPortfolio } from "../src/engine/indexPortfolio.js";
import { MIN_PRICE, reais } from "../src/engine/money.js";

/** 22 clubes cuja soma de cotações é R$ 520,00, com o FLA3 a R$ 44,00. */
function precos22(): Record<string, number> {
  const prices: Record<string, number> = { FLA3: reais(44), CLB1: reais(36) };
  for (let i = 2; i < 22; i++) prices[`CLB${i}`] = reais(22);
  return prices;
}

describe("indexPortfolio: carteira índice", () => {
  it("entrada 1: soma R$ 520,00 em 22 clubes dá 134 ações de cada e R$ 30.320,00 em caixa", () => {
    const r = indexPortfolio(precos22());
    expect(r.sum).toBe(reais(520));
    expect(r.n).toBe(134);
    expect(r.cash).toBe(reais(30_320));
    expect(r.stockValue).toBe(134 * reais(520));
    expect(r.stockValue + r.cash).toBe(reais(100_000));
    expect(r.clubs).toHaveLength(22);
    expect(r.clubs.every((c) => c.shares === 134)).toBe(true);
  });

  it("entrada 2: a mesma quantidade é a que vai para a tesouraria na opção só caixa", () => {
    // A função devolve N; quem escolhe só caixa usa o mesmo N para a tesouraria.
    expect(indexPortfolio(precos22()).n).toBe(134);
  });

  it("entrada 4: soma R$ 457,30 dá 153 ações de cada e R$ 30.033,10 em caixa", () => {
    const r = indexPortfolio({ AAA3: reais(200), BBB3: reais(150), CCC3: reais(107.3) });
    expect(r.sum).toBe(reais(457.3));
    expect(r.n).toBe(153);
    expect(153 * r.sum).toBe(reais(69_966.9));
    expect(r.cash).toBe(reais(30_033.1));
  });

  it("entrada 5 e carteira 15: o custo de cada clube é o preço de referência", () => {
    const r = indexPortfolio(precos22());
    expect(r.clubs.find((c) => c.clubId === "FLA3")).toEqual({
      clubId: "FLA3",
      shares: 134,
      costPerShare: reais(44),
    });
  });

  it("entrada 7: clube no piso de R$ 0,50 entra na soma como os outros", () => {
    const r = indexPortfolio({ AAA3: MIN_PRICE, BBB3: reais(10) });
    expect(r.sum).toBe(MIN_PRICE + reais(10));
    expect(r.clubs.find((c) => c.clubId === "AAA3")!.shares).toBe(r.n);
    expect(r.n).toBe(Math.floor(7_000_000 / (MIN_PRICE + reais(10))));
  });

  it("entrada 16: soma acima de R$ 70.000,00 dá R$ 100.000,00 em caixa e nenhuma ação", () => {
    const r = indexPortfolio({ AAA3: reais(70_000), BBB3: 50 });
    expect(r.n).toBe(0);
    expect(r.cash).toBe(reais(100_000));
    expect(r.stockValue).toBe(0);
    expect(r.clubs.every((c) => c.shares === 0)).toBe(true);
  });

  describe("limites", () => {
    it("soma exatamente R$ 70.000,00 dá N = 1 e R$ 30.000,00 em caixa", () => {
      const r = indexPortfolio({ AAA3: reais(70_000) });
      expect(r.n).toBe(1);
      expect(r.cash).toBe(reais(30_000));
    });

    it("recusa preço abaixo do piso, não inteiro e lista vazia", () => {
      expect(() => indexPortfolio({ AAA3: MIN_PRICE - 1 })).toThrow();
      expect(() => indexPortfolio({ AAA3: 100.5 })).toThrow();
      expect(() => indexPortfolio({})).toThrow();
    });

    it("propriedade: caixa + N × soma = R$ 100.000,00 e o caixa fica entre R$ 30.000,00 e R$ 30.000,00 + uma ação de cada clube", () => {
      for (let sum = 50; sum <= 7_000_000; sum = Math.ceil(sum * 1.37) + 11) {
        const r = indexPortfolio({ AAA3: sum });
        expect(r.cash + r.n * r.sum).toBe(reais(100_000));
        expect(r.cash).toBeGreaterThanOrEqual(reais(30_000));
        expect(r.cash).toBeLessThan(reais(30_000) + r.sum);
      }
    });
  });
});
