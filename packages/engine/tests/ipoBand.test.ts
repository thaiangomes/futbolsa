import { describe, expect, it } from "vitest";
import { bidReserve, ipoBand, placementPrice, validateBid } from "../src/engine/ipoBand.js";
import { priceBand, suggestedPrice } from "../src/engine/bookbuilding.js";
import { reais } from "../src/engine/money.js";
import { mulDivRound } from "../src/engine/rounding.js";

describe("preço pela colocação", () => {
  it("1 a 20 usam o preço sugerido da colocação", () => {
    for (let p = 1; p <= 20; p++) expect(placementPrice(p)).toBe(suggestedPrice(p));
  });

  it("21 a 24 (os promovidos, na ordem da Série B) usam os preços do 17º ao 20º", () => {
    expect([21, 22, 23, 24].map(placementPrice)).toEqual([reais(9), reais(7), reais(5), reais(3)]);
  });

  it("sem colocação (Clube dos Treze na Série B) usa o preço do 20º", () => {
    expect(placementPrice(null)).toBe(reais(3));
  });

  it("colocação 0, 25, fracionada ou negativa é erro", () => {
    for (const p of [0, 25, 1.5, -1, Number.NaN]) expect(() => placementPrice(p)).toThrow();
  });
});

describe("faixa do IPO", () => {
  it("ipo 2: 1º sem copa → centro R$ 50,00, piso R$ 30,00, teto R$ 70,00", () => {
    const b = ipoBand({ placement: 1, cupExpected: 0, buybackBp: 15_000 });
    expect([b.center, b.floor, b.ceiling]).toEqual([reais(50), reais(30), reais(70)]);
  });

  it("ipo 3: sem colocação e sem copa → R$ 3,00, R$ 1,80 e R$ 4,20", () => {
    const b = ipoBand({ placement: null, cupExpected: 0, buybackBp: 15_000 });
    expect([b.center, b.floor, b.ceiling]).toEqual([reais(3), reais(1.8), reais(4.2)]);
  });

  it("ipo 4: promovidos 21 a 24 têm centros R$ 9, R$ 7, R$ 5 e R$ 3 (mais as copas)", () => {
    expect([21, 22, 23, 24].map((p) => ipoBand({ placement: p, cupExpected: 0, buybackBp: 15_000 }).center)).toEqual([
      reais(9),
      reais(7),
      reais(5),
      reais(3),
    ]);
    // com R$ 1,00 de copa e recompra de 1,5×, soma R$ 2,50 ao centro
    expect(ipoBand({ placement: 21, cupExpected: reais(1), buybackBp: 15_000 }).center).toBe(reais(11.5));
  });

  it("ipo 5: 3º com R$ 4,22 de copas e recompra de 1,5× → R$ 50,55, R$ 30,33 e R$ 70,77", () => {
    const b = ipoBand({ placement: 3, cupExpected: reais(4.22), buybackBp: 15_000 });
    expect(b.center).toBe(5055);
    expect(b.floor).toBe(3033);
    expect(b.ceiling).toBe(7077);
    // a conta para a tela mostrar
    expect(b.placementPrice).toBe(reais(40));
    expect(b.cupsPart).toBe(1055);
  });

  it("ipo 6: copas zero não somam", () => {
    const b = ipoBand({ placement: 3, cupExpected: 0, buybackBp: 15_000 });
    expect(b.center).toBe(reais(40));
    expect(b.cupsPart).toBe(0);
  });

  it("a largura é configurável em pontos-base e o padrão é 40%", () => {
    const b = ipoBand({ placement: 1, cupExpected: 0, buybackBp: 15_000, widthBp: 1000 });
    expect([b.floor, b.ceiling]).toEqual([reais(45), reais(55)]);
  });

  it("regressão: o centro é o da simulação (ipoCups ligado) para as colocações de 1 a 20", () => {
    for (let p = 1; p <= 20; p++) {
      for (const cups of [0, 1, 99, 422, 1234, 5555]) {
        const sim = priceBand(suggestedPrice(p) + Math.round(cups * (1 + 1.5)), 0.4);
        const b = ipoBand({ placement: p, cupExpected: cups, buybackBp: 15_000 });
        expect([b.center, b.floor, b.ceiling]).toEqual([sim.center, sim.min, sim.max]);
        expect(b.cupsPart).toBe(mulDivRound(cups, 25_000, 10_000));
      }
    }
  });

  it("rejeita copas negativas ou fracionadas e recompra fora do inteiro", () => {
    expect(() => ipoBand({ placement: 1, cupExpected: -1, buybackBp: 15_000 })).toThrow();
    expect(() => ipoBand({ placement: 1, cupExpected: 1.5, buybackBp: 15_000 })).toThrow();
    expect(() => ipoBand({ placement: 1, cupExpected: 0, buybackBp: -1 })).toThrow();
  });
});

describe("reserva e validação da oferta", () => {
  const band = { floor: 3033, ceiling: 7077 };

  it("reserva = quantidade × min(preço máximo, teto)", () => {
    expect(bidReserve(1500, reais(40), band)).toBe(reais(60_000));
    expect(bidReserve(100, reais(90), band)).toBe(7077 * 100);
  });

  it("ipo 8: 1.500 até R$ 40 com R$ 100.000 livres reserva R$ 60.000", () => {
    const r = validateBid({ quantity: 1500, maxPrice: reais(40), band, freeCash: reais(100_000), currentReserve: 0 });
    expect(r).toEqual({ ok: true, reserve: reais(60_000), delta: reais(60_000) });
  });

  it("ipo 9: 100 até R$ 90 com teto R$ 70,77 reserva R$ 7.077", () => {
    const r = validateBid({ quantity: 100, maxPrice: reais(90), band, freeCash: reais(100_000), currentReserve: 0 });
    expect(r).toEqual({ ok: true, reserve: reais(7077), delta: reais(7077) });
  });

  it("ipo 10: R$ 30,32 com piso R$ 30,33 é recusada", () => {
    const r = validateBid({ quantity: 10, maxPrice: 3032, band, freeCash: reais(100_000), currentReserve: 0 });
    expect(r).toEqual({ ok: false, code: "below_band_floor" });
  });

  it("o piso exato passa", () => {
    const r = validateBid({ quantity: 10, maxPrice: 3033, band, freeCash: reais(100_000), currentReserve: 0 });
    expect(r.ok).toBe(true);
  });

  it("ipo 11: 1.200 até R$ 35 com R$ 40.000 livres é recusada", () => {
    const r = validateBid({ quantity: 1200, maxPrice: reais(35), band, freeCash: reais(40_000), currentReserve: 0 });
    expect(r).toEqual({ ok: false, code: "insufficient_cash" });
  });

  it("reserva exatamente igual ao caixa livre passa", () => {
    const r = validateBid({ quantity: 1000, maxPrice: reais(40), band, freeCash: reais(40_000), currentReserve: 0 });
    expect(r).toEqual({ ok: true, reserve: reais(40_000), delta: reais(40_000) });
  });

  it("um centavo além do caixa livre é recusado", () => {
    const r = validateBid({ quantity: 1000, maxPrice: reais(40), band, freeCash: reais(40_000) - 1, currentReserve: 0 });
    expect(r).toEqual({ ok: false, code: "insufficient_cash" });
  });

  it("ipo 13: editar de 1.500 até R$ 40 para 1.000 até R$ 38 → reserva R$ 38.000 e diferença −R$ 22.000", () => {
    // R$ 60.000 reservados de R$ 100.000: livre R$ 40.000
    const r = validateBid({
      quantity: 1000,
      maxPrice: reais(38),
      band,
      freeCash: reais(40_000),
      currentReserve: reais(60_000),
    });
    expect(r).toEqual({ ok: true, reserve: reais(38_000), delta: -reais(22_000) });
  });

  it("na edição, a reserva atual conta como livre (limite = livre + reserva atual)", () => {
    // livre R$ 10.000 e reserva atual R$ 20.000: dá para subir até R$ 30.000
    const ok = validateBid({ quantity: 750, maxPrice: reais(40), band, freeCash: reais(10_000), currentReserve: reais(20_000) });
    expect(ok).toEqual({ ok: true, reserve: reais(30_000), delta: reais(10_000) });
    const no = validateBid({ quantity: 751, maxPrice: reais(40), band, freeCash: reais(10_000), currentReserve: reais(20_000) });
    expect(no).toEqual({ ok: false, code: "insufficient_cash" });
  });

  it("quantidade 0, fracionada, negativa, não numérica ou grande demais é invalid_quantity", () => {
    for (const quantity of [0, 1.5, -3, Number.NaN, 2_147_483_648]) {
      const r = validateBid({ quantity, maxPrice: reais(40), band, freeCash: reais(100_000), currentReserve: 0 });
      expect(r).toEqual({ ok: false, code: "invalid_quantity" });
    }
  });

  it("preço com fração de centavo, zero ou negativo é invalid_price", () => {
    for (const maxPrice of [0, -100, 3500.5, Number.NaN]) {
      const r = validateBid({ quantity: 10, maxPrice, band, freeCash: reais(100_000), currentReserve: 0 });
      expect(r).toEqual({ ok: false, code: "invalid_price" });
    }
  });

  it("a ordem dos códigos: quantidade, preço, piso, caixa", () => {
    const tudoErrado = { quantity: 0, maxPrice: 1, band, freeCash: 0, currentReserve: 0 };
    expect(validateBid(tudoErrado)).toEqual({ ok: false, code: "invalid_quantity" });
    expect(validateBid({ ...tudoErrado, quantity: 5, maxPrice: 0 })).toEqual({ ok: false, code: "invalid_price" });
    expect(validateBid({ ...tudoErrado, quantity: 5 })).toEqual({ ok: false, code: "below_band_floor" });
    expect(validateBid({ ...tudoErrado, quantity: 5, maxPrice: reais(40) })).toEqual({
      ok: false,
      code: "insufficient_cash",
    });
  });
});
