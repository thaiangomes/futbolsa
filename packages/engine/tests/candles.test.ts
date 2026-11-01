import { describe, expect, it } from "vitest";
import { applyTrade, candleStart, fillGaps, type Candle } from "../src/engine/candles.js";
import { reais } from "../src/engine/money.js";

const at = (iso: string) => Date.parse(iso);

function candleOf(interval: "15m" | "1d", trades: [string, number, number][]): Candle {
  let c: Candle | undefined;
  for (const [iso, price, qty] of trades) c = applyTrade(c, interval, at(iso), price, qty);
  return c!;
}

describe("início do candle", () => {
  it("diário: 0h de Brasília (02h UTC ainda é o dia anterior)", () => {
    expect(candleStart("1d", at("2027-04-05T02:00:00Z"))).toBe(at("2027-04-04T00:00:00-03:00"));
  });

  it("de 15 minutos: 10h14m59s e 10h15m caem em candles diferentes", () => {
    expect(candleStart("15m", at("2027-04-05T10:14:59.999-03:00"))).toBe(at("2027-04-05T10:00:00-03:00"));
    expect(candleStart("15m", at("2027-04-05T10:15:00-03:00"))).toBe(at("2027-04-05T10:15:00-03:00"));
  });

  it("de 15 minutos na virada do dia: 23h59 e 00h00 de Brasília", () => {
    expect(candleStart("15m", at("2027-04-04T23:59:59-03:00"))).toBe(at("2027-04-04T23:45:00-03:00"));
    expect(candleStart("15m", at("2027-04-05T00:00:00-03:00"))).toBe(at("2027-04-05T00:00:00-03:00"));
  });
});

describe("candle do dia", () => {
  it("carteira 22: abertura, máxima, mínima, fechamento e volume do dia", () => {
    const c = candleOf("1d", [
      ["2027-04-19T09:00:00-03:00", reais(40), 100],
      ["2027-04-19T11:00:00-03:00", reais(45), 50],
      ["2027-04-19T15:00:00-03:00", reais(39), 10],
      ["2027-04-19T17:00:00-03:00", reais(42), 40],
    ]);
    expect(c).toEqual({
      start: at("2027-04-19T00:00:00-03:00"),
      open: reais(40),
      high: reais(45),
      low: reais(39),
      close: reais(42),
      volume: 200,
    });
  });

  it("um único negócio dá abertura, máxima, mínima e fechamento iguais", () => {
    const c = candleOf("1d", [["2027-04-19T09:00:00-03:00", reais(40), 7]]);
    expect([c.open, c.high, c.low, c.close, c.volume]).toEqual([reais(40), reais(40), reais(40), reais(40), 7]);
  });

  it("negócio exatamente à meia-noite abre o dia novo, e o do dia anterior é recusado no candle velho", () => {
    const c = candleOf("1d", [["2027-04-19T23:59:59-03:00", reais(40), 1]]);
    expect(() => applyTrade(c, "1d", at("2027-04-20T00:00:00-03:00"), reais(41), 1)).toThrow();
    expect(applyTrade(undefined, "1d", at("2027-04-20T00:00:00-03:00"), reais(41), 1).start).toBe(
      at("2027-04-20T00:00:00-03:00"),
    );
  });

  it("recusa quantidade e preço inválidos", () => {
    expect(() => applyTrade(undefined, "1d", at("2027-04-19T09:00:00-03:00"), reais(40), 0)).toThrow();
    expect(() => applyTrade(undefined, "1d", at("2027-04-19T09:00:00-03:00"), 40.5, 1)).toThrow();
    expect(() => applyTrade(undefined, "1d", at("2027-04-19T09:00:00-03:00"), reais(40), 1.5)).toThrow();
  });
});

describe("preenchimento de períodos sem negócio", () => {
  const dia = (d: number) => at(`2027-04-${String(d).padStart(2, "0")}T00:00:00-03:00`);
  const comNegocio = candleOf("1d", [["2027-04-19T10:00:00-03:00", reais(44), 30]]);

  it("carteira 23: dia sem negócio repete o fechamento anterior com volume zero", () => {
    const serie = fillGaps([comNegocio], "1d", dia(19), dia(21), reais(35));
    expect(serie.map((c) => c.start)).toEqual([dia(19), dia(20), dia(21)]);
    expect(serie[1]).toEqual({ start: dia(20), open: reais(44), high: reais(44), low: reais(44), close: reais(44), volume: 0 });
    expect(serie[2]!.close).toBe(reais(44));
    expect(serie[2]!.volume).toBe(0);
  });

  it("carteira 23: antes do primeiro negócio a linha fica no preço do IPO", () => {
    const serie = fillGaps([comNegocio], "1d", dia(17), dia(19), reais(35));
    expect(serie.map((c) => c.close)).toEqual([reais(35), reais(35), reais(44)]);
    expect(serie[0]!.volume).toBe(0);
  });

  it("sem nenhum negócio a série inteira fica no preço do IPO", () => {
    const serie = fillGaps([], "1d", dia(19), dia(21), reais(35));
    expect(serie.map((c) => c.close)).toEqual([reais(35), reais(35), reais(35)]);
  });

  it("um candle anterior ao começo da janela dá o fechamento de partida", () => {
    const serie = fillGaps([comNegocio], "1d", dia(21), dia(22), reais(35));
    expect(serie.map((c) => c.close)).toEqual([reais(44), reais(44)]);
  });

  it("candles de 15 minutos: a janela cobre os períodos de ponta a ponta", () => {
    const c = candleOf("15m", [["2027-04-19T10:05:00-03:00", reais(44), 3]]);
    const serie = fillGaps([c], "15m", at("2027-04-19T10:00:00-03:00"), at("2027-04-19T10:30:00-03:00"), reais(35));
    expect(serie.map((x) => x.close)).toEqual([reais(44), reais(44), reais(44)]);
    expect(serie.map((x) => x.volume)).toEqual([3, 0, 0]);
  });

  it("recusa janela invertida", () => {
    expect(() => fillGaps([], "1d", dia(21), dia(19), reais(35))).toThrow();
  });
});
