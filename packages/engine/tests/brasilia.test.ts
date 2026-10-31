import { describe, expect, it } from "vitest";
import { dayStart, monthCloseAt, monthKey, nextDayAt, nextDayStart } from "../src/engine/brasilia.js";

const at = (iso: string) => Date.parse(iso);

describe("dia e mês de Brasília", () => {
  it("rankings 11: o fechamento de junho é 23h59 de 2027-06-30; o negócio das 23h58 entra e o das 00h01 de julho não", () => {
    const close = monthCloseAt(2027, 6);
    expect(close).toBe(at("2027-06-30T23:59:00-03:00"));
    expect(at("2027-06-30T23:58:00-03:00")).toBeLessThanOrEqual(close);
    expect(at("2027-07-01T00:01:00-03:00")).toBeGreaterThan(close);
  });

  it("rankings 11: o negócio exatamente às 23:59:00,000 conta no mês", () => {
    expect(at("2027-06-30T23:59:00-03:00")).toBeLessThanOrEqual(monthCloseAt(2027, 6));
    expect(at("2027-06-30T23:59:00.001-03:00")).toBeGreaterThan(monthCloseAt(2027, 6));
  });

  it("fevereiro de ano bissexto fecha em 29 e dezembro em 31", () => {
    expect(monthCloseAt(2028, 2)).toBe(at("2028-02-29T23:59:00-03:00"));
    expect(monthCloseAt(2027, 2)).toBe(at("2027-02-28T23:59:00-03:00"));
    expect(monthCloseAt(2027, 12)).toBe(at("2027-12-31T23:59:00-03:00"));
  });

  it("início do dia: 02h UTC ainda é o dia anterior em Brasília", () => {
    // 2027-04-05T02:00Z = 2027-04-04 23h em Brasília.
    expect(dayStart(at("2027-04-05T02:00:00Z"))).toBe(at("2027-04-04T00:00:00-03:00"));
  });

  it("negócio exatamente à meia-noite de Brasília abre o dia novo", () => {
    const meiaNoite = at("2027-04-05T00:00:00-03:00");
    expect(dayStart(meiaNoite)).toBe(meiaNoite);
    expect(dayStart(meiaNoite - 1)).toBe(at("2027-04-04T00:00:00-03:00"));
  });

  it("início do dia seguinte", () => {
    expect(nextDayStart(at("2027-04-04T16:00:00-03:00"))).toBe(at("2027-04-05T00:00:00-03:00"));
    expect(nextDayStart(at("2027-12-31T23:59:00-03:00"))).toBe(at("2028-01-01T00:00:00-03:00"));
  });

  it("ipo 1: o dia seguinte às 10h de Brasília depois do fechamento das 16h", () => {
    expect(nextDayAt(at("2027-04-04T16:00:00-03:00"), 10)).toBe(at("2027-04-05T10:00:00-03:00"));
  });

  it("dia seguinte às 10h vale também para fechamento de madrugada em Brasília", () => {
    // 2027-04-05T01:00Z = 2027-04-04 22h em Brasília → a negociação abre em 04-05 às 10h.
    expect(nextDayAt(at("2027-04-05T01:00:00Z"), 10)).toBe(at("2027-04-05T10:00:00-03:00"));
  });

  it("chave do mês pelo fuso de Brasília", () => {
    expect(monthKey(at("2027-06-30T23:58:00-03:00"))).toBe("2027-06");
    expect(monthKey(at("2027-07-01T00:01:00-03:00"))).toBe("2027-07");
    // 2027-07-01T02:30Z = 2027-06-30 23h30 em Brasília.
    expect(monthKey(at("2027-07-01T02:30:00Z"))).toBe("2027-06");
  });

  it("recusa mês, hora e instante inválidos", () => {
    expect(() => monthCloseAt(2027, 0)).toThrow();
    expect(() => monthCloseAt(2027, 13)).toThrow();
    expect(() => nextDayAt(at("2027-04-04T16:00:00-03:00"), 24)).toThrow();
    expect(() => nextDayAt(at("2027-04-04T16:00:00-03:00"), -1)).toThrow();
    expect(() => dayStart(Number.NaN)).toThrow();
  });
});
