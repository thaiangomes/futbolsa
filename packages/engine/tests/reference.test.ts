import { describe, expect, it } from "vitest";
import { decayedReference, nextReference, staleDays } from "../src/engine/reference.js";

const DAY = 24 * 60 * 60 * 1000;
// 12h de Brasília de um dia qualquer.
const noon = Date.UTC(2026, 2, 6, 15);

describe("decayedReference (rodada Z)", () => {
  it("sem dias parados, fica no último preço", () => {
    expect(decayedReference(3_177, 2_380, 0)).toBe(3_177);
  });

  it("desce 10% por dia em direção ao valor justo e para nele", () => {
    expect(decayedReference(3_000, 1_000, 1)).toBe(2_700);
    expect(decayedReference(3_000, 1_000, 2)).toBe(2_430);
    expect(decayedReference(3_000, 1_000, 60)).toBe(1_000);
  });

  it("sobe quando o preço está abaixo do valor justo e para nele", () => {
    expect(decayedReference(900, 2_000, 1)).toBe(1_000);
    expect(decayedReference(900, 1_000, 5)).toBe(1_000);
  });

  it("nunca fica abaixo de R$ 0,50", () => {
    expect(decayedReference(60, 10, 60)).toBe(50);
  });

  it("conta dias civis de Brasília sem negócio", () => {
    expect(staleDays(noon, noon + 30 * 60 * 1000)).toBe(0);
    expect(staleDays(noon, noon + 3 * DAY)).toBe(3);
    expect(staleDays(noon, noon - DAY)).toBe(0);
    expect(staleDays(0, noon)).toBe(60);
  });
});

describe("nextReference", () => {
  const base = { lastPrice: 3_000, lastTradeAt: noon, fair: 1_600, now: noon };
  it("sem referência até 2 dias sem negócio", () => {
    expect(nextReference({ ...base, now: noon + 2 * DAY - 1 })).toBeNull();
  });
  it("depois da carência desce 10% por dia rumo ao justo", () => {
    expect(nextReference({ ...base, now: noon + 2 * DAY })).toBe(2_700);
    expect(nextReference({ ...base, now: noon + 3 * DAY + 1000 })).toBe(2_430);
  });
  it("para no valor justo", () => {
    expect(nextReference({ ...base, now: noon + 60 * DAY })).toBe(1_600);
  });
  it("preço a até 20% do justo (para os dois lados) fica sem referência", () => {
    expect(nextReference({ ...base, lastPrice: 1_920, now: noon + 10 * DAY })).toBeNull();
    expect(nextReference({ ...base, lastPrice: 1_280, now: noon + 10 * DAY })).toBeNull();
    expect(nextReference({ ...base, lastPrice: 1_921, now: noon + 10 * DAY })).not.toBeNull();
  });
  it("preço abaixo do justo sobe", () => {
    expect(nextReference({ ...base, lastPrice: 1_000, fair: 2_000, now: noon + 2 * DAY })).toBe(1_111);
  });
  it("clube sem negócio ainda não tem referência", () => {
    expect(nextReference({ ...base, lastTradeAt: null, now: noon + 30 * DAY })).toBeNull();
  });
});
