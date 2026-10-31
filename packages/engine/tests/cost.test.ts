import { describe, expect, it } from "vitest";
import {
  addDividend,
  averagePrice,
  buy,
  creditShares,
  debitShares,
  emptyPosition,
  sell,
  summarize,
  type CostPosition,
} from "../src/engine/cost.js";
import { reais } from "../src/engine/money.js";

/** Ana com 1.000 FLA3 recebidos no IPO a R$ 35. */
const ana1000 = () => buy(emptyPosition(), 1_000, reais(35));
/** Ana com 1.500 FLA3 a preço médio R$ 37 (custo R$ 55.500). */
const ana1500 = () => buy(ana1000(), 500, reais(41));
/** Ana com 1.200 FLA3 a preço médio R$ 37 (custo R$ 44.400). */
const ana1200 = () => sell(ana1500(), 300, reais(45)).position;

describe("preço médio e custo", () => {
  it("carteira 1: 1.000 a R$ 35 dão custo R$ 35.000,00 e preço médio R$ 35,00", () => {
    const p = ana1000();
    expect(p.shares).toBe(1_000);
    expect(p.cost).toBe(reais(35_000));
    expect(averagePrice(p)).toBe(reais(35));
  });

  it("carteira 2: comprar 500 a R$ 41 soma ao custo e leva o preço médio a R$ 37,00", () => {
    const p = ana1500();
    expect(p.shares).toBe(1_500);
    expect(p.cost).toBe(reais(55_500));
    expect(averagePrice(p)).toBe(reais(37));
  });

  it("carteira 3: vender 300 a R$ 45 mantém o preço médio, tira custo na proporção e realiza R$ 2.400,00", () => {
    const { position, realized } = sell(ana1500(), 300, reais(45));
    expect(position.shares).toBe(1_200);
    expect(position.cost).toBe(reais(44_400));
    expect(averagePrice(position)).toBe(reais(37));
    expect(realized).toBe(reais(2_400));
    expect(position.realized).toBe(reais(2_400));
  });

  it("carteira 4: vender 200 a R$ 30 abaixo do médio realiza −R$ 1.400,00 e mantém o médio em R$ 37,00", () => {
    const { position, realized } = sell(ana1200(), 200, reais(30));
    expect(realized).toBe(reais(-1_400));
    expect(averagePrice(position)).toBe(reais(37));
    expect(position.realized).toBe(reais(2_400 - 1_400));
  });

  it("carteira 5: zerar a posição zera o custo e a compra seguinte recomeça do zero", () => {
    const zerada = sell(ana1000(), 1_000, reais(40)).position;
    expect(zerada.shares).toBe(0);
    expect(zerada.cost).toBe(0);
    const nova = buy(zerada, 100, reais(50));
    expect(nova.cost).toBe(reais(5_000));
    expect(averagePrice(nova)).toBe(reais(50));
  });

  it("carteira 6: dividendo não mexe no custo nem no preço médio", () => {
    const p = addDividend(ana1200(), reais(360));
    expect(p.dividends).toBe(reais(360));
    expect(p.cost).toBe(reais(44_400));
    expect(averagePrice(p)).toBe(reais(37));
  });

  it("carteira 8: zerar a posição mantém o total de dividendos do clube na temporada", () => {
    const comDividendo = addDividend(ana1200(), reais(360));
    const zerada = sell(comDividendo, 1_200, reais(44)).position;
    expect(zerada.shares).toBe(0);
    expect(zerada.dividends).toBe(reais(360));
  });

  it("carteira 17/admin 12: estorno entra como dividendo negativo no total", () => {
    const p = addDividend(addDividend(ana1200(), reais(360)), reais(-400));
    expect(p.dividends).toBe(reais(-40));
  });

  it("carteira 9: valor a mercado R$ 52.800,00 e não realizado R$ 8.400,00 (+18,9%)", () => {
    const s = summarize(ana1200(), reais(44));
    expect(s.marketValue).toBe(reais(52_800));
    expect(s.unrealized).toBe(reais(8_400));
    expect(s.unrealizedPermille).toBe(189);
  });

  it("carteira 10: clube sem negócio é marcado pelo preço do IPO que vier no parâmetro", () => {
    const p = buy(emptyPosition(), 100, reais(35));
    const s = summarize(p, reais(35));
    expect(s.marketValue).toBe(reais(3_500));
    expect(s.unrealized).toBe(0);
  });

  it("carteira 14: resultado total do clube = realizado + não realizado + dividendos = R$ 11.160,00", () => {
    const p = addDividend(ana1200(), reais(360));
    const s = summarize(p, reais(44));
    expect(s.total).toBe(reais(2_400 + 8_400 + 360));
  });

  it("carteira 38: o dividendo a receber entra no resultado total", () => {
    const p = ana1200();
    expect(summarize(p, reais(44), reais(360)).total).toBe(reais(2_400 + 8_400 + 360));
  });

  it("carteira 21: recompra de 1.200 a R$ 19,35 é venda com resultado −R$ 21.180,00 e zera a posição", () => {
    const { position, realized } = sell(ana1200(), 1_200, reais(19.35));
    expect(realized).toBe(reais(-21_180));
    expect(position.shares).toBe(0);
    expect(position.cost).toBe(0);
  });

  it("carteira 39: crédito do admin entra pelo preço exibido, sem resultado realizado", () => {
    const cem = buy(emptyPosition(), 100, reais(37));
    const creditado = creditShares(cem, 100, reais(44));
    expect(creditado.shares).toBe(200);
    expect(creditado.cost).toBe(reais(8_100));
    expect(averagePrice(creditado)).toBe(reais(40.5));
    expect(creditado.realized).toBe(0);
  });

  it("carteira 39: débito do admin tira custo na proporção, mantém o médio e não gera resultado", () => {
    const cem = buy(emptyPosition(), 100, reais(37));
    const debitado = debitShares(creditShares(cem, 100, reais(44)), 50);
    expect(debitado.shares).toBe(150);
    expect(debitado.cost).toBe(reais(6_075));
    expect(averagePrice(debitado)).toBe(reais(40.5));
    expect(debitado.realized).toBe(0);
  });

  it("entrada 5 e carteira 15: carteira índice entra com o preço de referência como preço médio", () => {
    const p = buy(emptyPosition(), 150, reais(44));
    expect(averagePrice(p)).toBe(reais(44));
  });

  describe("limites", () => {
    it("recusa vender mais do que há e quantidade ou preço inválidos", () => {
      expect(() => sell(ana1000(), 1_001, reais(40))).toThrow();
      expect(() => sell(ana1000(), 0, reais(40))).toThrow();
      expect(() => buy(emptyPosition(), 0, reais(40))).toThrow();
      expect(() => buy(emptyPosition(), 1.5, reais(40))).toThrow();
      expect(() => buy(emptyPosition(), 1, 40.5)).toThrow();
      expect(() => debitShares(ana1000(), 1_001)).toThrow();
    });

    it("custo que força arredondamento: o meio centavo sobe e a soma do que saiu fecha o custo", () => {
      // 3 ações por R$ 10,00: cada ação custa R$ 3,333...
      let p: CostPosition = { shares: 3, cost: 1_000, realized: 0, dividends: 0 };
      const saidas: number[] = [];
      for (let i = 0; i < 3; i++) {
        const antes = p.cost;
        p = sell(p, 1, 0).position;
        saidas.push(antes - p.cost);
      }
      expect(saidas).toEqual([333, 334, 333]); // 333,33 → 333; 333,5 → 334; resto
      expect(saidas.reduce((a, b) => a + b, 0)).toBe(1_000);
      expect(p.cost).toBe(0);
    });

    it("regressão: venda total sempre deixa o custo exatamente zero", () => {
      const p = buy(buy(emptyPosition(), 7, 333), 11, 1_017);
      expect(sell(p, 18, 500).position.cost).toBe(0);
    });

    it("preço médio de posição vazia é zero", () => {
      expect(averagePrice(emptyPosition())).toBe(0);
    });
  });
});
