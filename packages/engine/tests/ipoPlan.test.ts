import { describe, expect, it } from "vitest";
import { priceBand, runBookbuilding } from "../src/engine/bookbuilding.js";
import { ipoDates, mmLot, postponeClose } from "../src/engine/ipoPlan.js";
import { reais } from "../src/engine/money.js";

const at = (iso: string) => Date.parse(iso);

describe("datas do IPO", () => {
  const dates = ipoDates(at("2027-04-11T16:00:00-03:00"));

  it("ipo 1: primeiro jogo em 2027-04-11 às 16h abre as ofertas em 2027-03-28 às 16h e fecha em 2027-04-04 às 16h", () => {
    expect(dates.opensAt).toBe(at("2027-03-28T16:00:00-03:00"));
    expect(dates.closesAt).toBe(at("2027-04-04T16:00:00-03:00"));
  });

  it("ipo 1: a negociação abre em 2027-04-05 às 10h de Brasília", () => {
    expect(dates.tradingOpensAt).toBe(at("2027-04-05T10:00:00-03:00"));
  });

  it("ipo 27: as datas já calculadas não dependem do jogo adiado depois (a função só lê o horário recebido)", () => {
    // O jogo vai para 2027-04-18, mas as datas ficam as da abertura.
    expect(dates).toEqual(ipoDates(at("2027-04-11T16:00:00-03:00")));
    expect(ipoDates(at("2027-04-18T16:00:00-03:00")).closesAt).not.toBe(dates.closesAt);
  });

  it("ipo 28: adiar o fechamento para 2027-04-06 às 16h leva a negociação a 2027-04-07 às 10h", () => {
    const adiado = postponeClose(dates, at("2027-04-06T16:00:00-03:00"), at("2027-04-01T12:00:00-03:00"));
    expect(adiado.closesAt).toBe(at("2027-04-06T16:00:00-03:00"));
    expect(adiado.tradingOpensAt).toBe(at("2027-04-07T10:00:00-03:00"));
    expect(adiado.opensAt).toBe(dates.opensAt);
  });

  it("ipo 28: antecipar o fechamento para 2027-04-02 é recusado", () => {
    expect(() => postponeClose(dates, at("2027-04-02T16:00:00-03:00"), at("2027-04-01T12:00:00-03:00"))).toThrow();
  });

  it("não adia depois que o período de ofertas fechou", () => {
    expect(() => postponeClose(dates, at("2027-04-06T16:00:00-03:00"), at("2027-04-04T16:00:00-03:00"))).toThrow();
  });

  it("adiar para o mesmo horário não muda nada", () => {
    expect(postponeClose(dates, dates.closesAt, at("2027-04-01T12:00:00-03:00"))).toEqual(dates);
  });

  it("recusa horário de primeiro jogo inválido", () => {
    expect(() => ipoDates(Number.NaN)).toThrow();
  });
});

describe("lote do formador", () => {
  it("ipo 29: oferta de 3.000 e 1.000 pontos-base dão lote de 300 e clube com 3.300 ações", () => {
    const lote = mmLot(3_000, 1_000);
    expect(lote).toBe(300);
    expect(3_000 + lote).toBe(3_300);
  });

  it("arredonda para baixo", () => {
    expect(mmLot(2_999, 1_000)).toBe(299);
    expect(mmLot(9, 1_000)).toBe(0);
  });

  it("lote zero é permitido e oferta zero ou pontos-base inválidos são recusados", () => {
    expect(mmLot(3_000, 0)).toBe(0);
    expect(() => mmLot(0, 1_000)).toThrow();
    expect(() => mmLot(3_000, -1)).toThrow();
    expect(() => mmLot(3_000, 10_001)).toThrow();
    expect(() => mmLot(3_000.5, 1_000)).toThrow();
  });

  describe("ipo 23: ações alocadas + sobra da tesouraria + lote = oferta + lote", () => {
    const band = priceBand(reais(50)); // R$ 30,00 a R$ 70,00
    const oferta = 3_000;
    const confere = (bids: Parameters<typeof runBookbuilding>[2]) => {
      const r = runBookbuilding(oferta, band, bids);
      const lote = mmLot(oferta, 1_000);
      const alocadas = r.allocations.reduce((s, a) => s + a.quantity, 0);
      expect(alocadas + r.treasuryShares + lote).toBe(oferta + lote);
      return r;
    };

    it("ipo 16: demanda maior que a oferta, com rateio", () => {
      const r = confere([
        { investorId: "ana", quantity: 1_500, maxPrice: reais(40) },
        { investorId: "bruno", quantity: 1_000, maxPrice: reais(37) },
        { investorId: "carla", quantity: 2_000, maxPrice: reais(35) },
      ]);
      expect(r.price).toBe(reais(35));
      expect(r.treasuryShares).toBe(0);
    });

    it("ipo 18: demanda de 1.200 no piso, 1.800 vão para a tesouraria", () => {
      const r = confere([{ investorId: "ana", quantity: 1_200, maxPrice: reais(30) }]);
      expect(r.price).toBe(band.min);
      expect(r.treasuryShares).toBe(1_800);
    });

    it("ipo 19: demanda exatamente igual à oferta a R$ 40, sem rateio", () => {
      const r = confere([{ investorId: "ana", quantity: 3_000, maxPrice: reais(40) }]);
      expect(r.price).toBe(reais(40));
      expect(r.fillRatio).toBe(1);
      expect(r.treasuryShares).toBe(0);
    });

    it("ipo 20: clube sem oferta, 3.000 vão para a tesouraria ao piso", () => {
      const r = confere([]);
      expect(r.price).toBe(band.min);
      expect(r.treasuryShares).toBe(3_000);
    });
  });
});
