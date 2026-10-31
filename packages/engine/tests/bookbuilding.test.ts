import { describe, expect, it } from "vitest";
import { priceBand, runBookbuilding, suggestedPrice } from "../src/engine/bookbuilding.js";

describe("suggestedPrice", () => {
  it("segue a escada do plano: 50, 45, 40, 35 e depois −2 até R$ 3 no 20º", () => {
    const prices = Array.from({ length: 20 }, (_, i) => suggestedPrice(i + 1));
    expect(prices.slice(0, 5)).toEqual([5000, 4500, 4000, 3500, 3300]);
    expect(prices[19]).toBe(300);
    expect(prices.reduce((a, b) => a + b, 0)).toBe(45800); // R$ 458, como no plano
  });

  it("rejeita colocação fora de 1..20", () => {
    expect(() => suggestedPrice(0)).toThrow();
    expect(() => suggestedPrice(21)).toThrow();
  });
});

describe("priceBand", () => {
  it("vai de −40% a +40% do centro", () => {
    expect(priceBand(5000)).toEqual({ center: 5000, min: 3000, max: 7000 });
  });
});

describe("runBookbuilding", () => {
  const band = priceBand(1000); // R$ 6,00 a R$ 14,00

  it("escolhe o maior preço em que a demanda acumulada cobre a oferta", () => {
    const result = runBookbuilding(100, band, [
      { investorId: "a", quantity: 40, maxPrice: 1300 },
      { investorId: "b", quantity: 40, maxPrice: 1100 },
      { investorId: "c", quantity: 40, maxPrice: 900 },
    ]);
    // Em R$ 13: 40; em R$ 11: 80; em R$ 9: 120 >= 100.
    expect(result.price).toBe(900);
    expect(result.treasuryShares).toBe(0);
  });

  it("todos pagam o mesmo preço", () => {
    const result = runBookbuilding(80, band, [
      { investorId: "a", quantity: 40, maxPrice: 1300 },
      { investorId: "b", quantity: 40, maxPrice: 1100 },
    ]);
    expect(result.price).toBe(1100);
    expect(result.allocations).toEqual([
      { investorId: "a", quantity: 40, cost: 44000 },
      { investorId: "b", quantity: 40, cost: 44000 },
    ]);
  });

  it("intenção acima do teto vale como teto; abaixo do piso fica de fora", () => {
    const result = runBookbuilding(50, band, [
      { investorId: "rico", quantity: 50, maxPrice: 9900 },
      { investorId: "barato", quantity: 50, maxPrice: 500 },
    ]);
    expect(result.price).toBe(1400);
    expect(result.allocations.map((a) => a.investorId)).toEqual(["rico"]);
  });

  it("faz rateio proporcional na quantidade quando sobra demanda no preço máximo", () => {
    const result = runBookbuilding(100, band, [
      { investorId: "a", quantity: 100, maxPrice: 1400 },
      { investorId: "b", quantity: 300, maxPrice: 1400 },
    ]);
    expect(result.price).toBe(1400);
    expect(result.fillRatio).toBe(0.25);
    expect(result.allocations).toEqual([
      { investorId: "a", quantity: 25, cost: 35000 },
      { investorId: "b", quantity: 75, cost: 105000 },
    ]);
  });

  it("no rateio, as ações do arredondamento vão para os maiores restos sem passar da oferta", () => {
    const result = runBookbuilding(10, band, [
      { investorId: "a", quantity: 7, maxPrice: 1400 },
      { investorId: "b", quantity: 7, maxPrice: 1400 },
      { investorId: "c", quantity: 7, maxPrice: 1400 },
    ]);
    const total = result.allocations.reduce((s, a) => s + a.quantity, 0);
    expect(total).toBe(10);
    // 10/21 de 7 = 3,33 para cada; a ação extra vai para quem registrou primeiro.
    expect(result.allocations.map((a) => a.quantity)).toEqual([4, 3, 3]);
  });

  it("aplica rateio também quando o preço justo fica abaixo do teto", () => {
    const result = runBookbuilding(100, band, [
      { investorId: "a", quantity: 60, maxPrice: 1200 },
      { investorId: "b", quantity: 60, maxPrice: 1000 },
    ]);
    expect(result.price).toBe(1000);
    expect(result.allocations.map((a) => a.quantity)).toEqual([50, 50]);
  });

  it("sem demanda suficiente no piso, vende no piso e a sobra vai para a tesouraria", () => {
    const result = runBookbuilding(100, band, [
      { investorId: "a", quantity: 30, maxPrice: 1200 },
      { investorId: "b", quantity: 20, maxPrice: 700 },
    ]);
    expect(result.price).toBe(600);
    expect(result.allocations.map((a) => a.quantity)).toEqual([30, 20]);
    expect(result.treasuryShares).toBe(50);
  });

  it("sem nenhuma intenção, tudo vai para a tesouraria", () => {
    const result = runBookbuilding(100, band, []);
    expect(result.allocations).toEqual([]);
    expect(result.treasuryShares).toBe(100);
  });
});
