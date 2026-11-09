import { describe, expect, it } from "vitest";
import { runBookbuilding } from "../src/engine/bookbuilding.js";
import { bidReserve } from "../src/engine/ipoBand.js";
import { settleIpoClub, type IpoBidInput } from "../src/engine/ipoSettlement.js";
import { reais } from "../src/engine/money.js";

const band = { floor: 3033, ceiling: 7077 };

/** Oferta com a reserva de sempre (quantidade × min(preço máximo, teto)). */
function bid(id: number, quantity: number, maxPrice: number, updatedAt = id, walletId = id * 10): IpoBidInput {
  return { id, walletId, quantity, maxPrice, reserved: bidReserve(quantity, maxPrice, band), updatedAt };
}

describe("liquidação de um clube", () => {
  it("ipo 16: oferta de 3.000 com 1.500 até R$ 40, 1.000 até R$ 37 e 2.000 até R$ 35 → corte R$ 35, fração 2/3", () => {
    const r = settleIpoClub({
      offer: 3000,
      band,
      lotBp: 2000,
      bids: [bid(1, 1500, reais(40)), bid(2, 1000, reais(37)), bid(3, 2000, reais(35))],
    });
    expect(r.cutPrice).toBe(reais(35));
    expect(r.ratio).toEqual({ num: 2, den: 3 });
    expect(r.demandAtCut).toBe(4500);
    expect(r.allocations.map((a) => [a.bidId, a.shares])).toEqual([
      [1, 1000],
      [2, 667],
      [3, 1333],
    ]);
    expect(r.leftoverShares).toBe(0);
  });

  it("ipo 17: duas ofertas iguais com o mesmo resto → a ação vai para a de updatedAt menor, mesmo vindo depois na lista", () => {
    const r = settleIpoClub({
      offer: 3,
      band,
      lotBp: 0,
      // a de id 1 foi alterada depois da de id 2
      bids: [bid(1, 2, reais(40), 2000), bid(2, 2, reais(40), 1000)],
    });
    const shares = Object.fromEntries(r.allocations.map((a) => [a.bidId, a.shares]));
    expect(shares).toEqual({ 1: 1, 2: 2 });
  });

  it("ipo 17: updatedAt igual desempata pelo id", () => {
    const r = settleIpoClub({
      offer: 3,
      band,
      lotBp: 0,
      bids: [bid(7, 2, reais(40), 1000), bid(5, 2, reais(40), 1000)],
    });
    const shares = Object.fromEntries(r.allocations.map((a) => [a.bidId, a.shares]));
    expect(shares).toEqual({ 5: 2, 7: 1 });
  });

  it("ipo 18: demanda de 1.200 no piso → preço no piso, 1.200 atendidos e 1.800 de sobra", () => {
    const r = settleIpoClub({ offer: 3000, band, lotBp: 2000, bids: [bid(1, 1200, band.floor)] });
    expect(r.cutPrice).toBe(band.floor);
    expect(r.allocations).toEqual([{ bidId: 1, walletId: 10, shares: 1200, paid: 1200 * band.floor, refunded: 0 }]);
    expect(r.leftoverShares).toBe(1800);
    expect(r.ratio).toEqual({ num: 1, den: 1 });
  });

  it("ipo 19: exatamente 3.000 a R$ 40 → preço R$ 40, fração 1/1 e nenhuma sobra", () => {
    const r = settleIpoClub({
      offer: 3000,
      band,
      lotBp: 2000,
      bids: [bid(1, 1000, reais(40)), bid(2, 2000, reais(40))],
    });
    expect(r.cutPrice).toBe(reais(40));
    expect(r.ratio).toEqual({ num: 1, den: 1 });
    expect(r.leftoverShares).toBe(0);
    expect(r.allocations.map((a) => a.shares)).toEqual([1000, 2000]);
  });

  it("ipo 20: sem ofertas → corte no piso e as 3.000 ações sobram", () => {
    const r = settleIpoClub({ offer: 3000, band, lotBp: 2000, bids: [] });
    expect(r.cutPrice).toBe(band.floor);
    expect(r.leftoverShares).toBe(3000);
    expect(r.demandAtCut).toBe(0);
    expect(r.allocations).toEqual([]);
    expect(r.treasuryCash).toBe(0);
    expect(r.ratio).toEqual({ num: 1, den: 1 });
  });

  it("ipo 21: 1.000 a R$ 35 com R$ 60.000 reservados → paga R$ 35.000, devolve R$ 25.000, a tesouraria recebe R$ 35.000", () => {
    const r = settleIpoClub({
      offer: 1000,
      band,
      lotBp: 2000,
      bids: [{ id: 1, walletId: 10, quantity: 1000, maxPrice: reais(35), reserved: reais(60_000), updatedAt: 1 }],
    });
    expect(r.cutPrice).toBe(reais(35));
    expect(r.allocations).toEqual([
      { bidId: 1, walletId: 10, shares: 1000, paid: reais(35_000), refunded: reais(25_000) },
    ]);
    expect(r.treasuryCash).toBe(reais(35_000));
  });

  it("ipo 22: oferta abaixo do corte → 0 ações e a reserva inteira de volta (e ela aparece na resposta)", () => {
    const r = settleIpoClub({
      offer: 1000,
      band,
      lotBp: 0,
      bids: [bid(1, 1000, reais(40)), bid(2, 500, reais(31))],
    });
    expect(r.cutPrice).toBe(reais(40));
    const baixa = r.allocations.find((a) => a.bidId === 2)!;
    expect(baixa).toEqual({ bidId: 2, walletId: 20, shares: 0, paid: 0, refunded: reais(31) * 500 });
  });

  it("oferta abaixo do piso (não deveria existir) também volta inteira, sem erro", () => {
    const r = settleIpoClub({
      offer: 1000,
      band,
      lotBp: 0,
      bids: [{ id: 1, walletId: 10, quantity: 10, maxPrice: band.floor - 1, reserved: 5000, updatedAt: 1 }],
    });
    expect(r.allocations).toEqual([{ bidId: 1, walletId: 10, shares: 0, paid: 0, refunded: 5000 }]);
    expect(r.cutPrice).toBe(band.floor);
  });

  it("ipo 29: demanda de 4.500 no corte → 3.000 para os jogadores, lote de 600 e clube com 3.600 ações", () => {
    const r = settleIpoClub({
      offer: 3000,
      band,
      lotBp: 2000,
      bids: [bid(1, 1500, reais(40)), bid(2, 1000, reais(37)), bid(3, 2000, reais(35))],
    });
    expect(r.allocations.reduce((s, a) => s + a.shares, 0)).toBe(3000);
    expect(r.lotShares).toBe(600);
    expect(r.totalShares).toBe(3600);
  });

  it("o lote arredonda para baixo e o total é a oferta mais o lote", () => {
    const r = settleIpoClub({ offer: 3001, band, lotBp: 2000, bids: [] });
    expect(r.lotShares).toBe(600);
    expect(r.totalShares).toBe(3601);
  });

  it("a ordem recebida não importa: o desempate é a última alteração", () => {
    const bids = [bid(1, 2, reais(40), 3), bid(2, 2, reais(40), 1), bid(3, 2, reais(40), 2)];
    const a = settleIpoClub({ offer: 4, band, lotBp: 0, bids });
    const b = settleIpoClub({ offer: 4, band, lotBp: 0, bids: [...bids].reverse() });
    expect(a).toEqual(b);
  });

  it("confere por dentro: reserva menor que o pago é erro (dado inconsistente), e id repetido também", () => {
    expect(() =>
      settleIpoClub({
        offer: 10,
        band,
        lotBp: 0,
        bids: [{ id: 1, walletId: 10, quantity: 10, maxPrice: reais(40), reserved: 1, updatedAt: 1 }],
      }),
    ).toThrow(/reserva/i);
    expect(() =>
      settleIpoClub({ offer: 10, band, lotBp: 0, bids: [bid(1, 5, reais(40)), bid(1, 5, reais(40))] }),
    ).toThrow(/repetid/i);
  });

  it("o resultado é o do runBookbuilding direto, com as ofertas ordenadas pela última alteração", () => {
    const bids = [bid(1, 1500, reais(40), 30), bid(2, 1000, reais(37), 10), bid(3, 2000, reais(35), 20)];
    const r = settleIpoClub({ offer: 3000, band, lotBp: 0, bids });
    const direto = runBookbuilding(
      3000,
      { center: 0, min: band.floor, max: band.ceiling },
      [bids[1]!, bids[2]!, bids[0]!].map((b) => ({ investorId: String(b.id), quantity: b.quantity, maxPrice: b.maxPrice })),
    );
    expect(r.cutPrice).toBe(direto.price);
    for (const a of direto.allocations) {
      expect(r.allocations.find((x) => String(x.bidId) === a.investorId)!.shares).toBe(a.quantity);
    }
  });

  it("ipo 23: 1.000 casos sorteados (semente fixa) conservam ações e dinheiro", () => {
    let seed = 20_261_108;
    const rnd = (n: number) => {
      // mulberry32
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    for (let caso = 0; caso < 1000; caso++) {
      const offer = 1 + rnd(5000);
      const lotBp = [0, 1000, 2000, 10_000][rnd(4)]!;
      const n = rnd(12);
      const bids: IpoBidInput[] = [];
      for (let i = 0; i < n; i++) {
        const maxPrice = band.floor - 50 + rnd(band.ceiling - band.floor + 3000);
        bids.push({
          id: i + 1,
          walletId: 100 + i,
          quantity: 1 + rnd(3000),
          maxPrice,
          reserved: 0,
          updatedAt: rnd(5), // empates de propósito
        });
        bids[i]!.reserved = bidReserve(bids[i]!.quantity, maxPrice, band);
      }
      const r = settleIpoClub({ offer, band, lotBp, bids });
      const alocadas = r.allocations.reduce((s, a) => s + a.shares, 0);
      expect(alocadas + r.leftoverShares).toBe(offer);
      expect(r.totalShares).toBe(offer + r.lotShares);
      expect(r.allocations).toHaveLength(bids.length);
      let pago = 0;
      for (const a of r.allocations) {
        const original = bids.find((b) => b.id === a.bidId)!;
        expect(a.paid).toBeLessThanOrEqual(original.reserved);
        expect(a.paid + a.refunded).toBe(original.reserved);
        expect(a.shares).toBeLessThanOrEqual(original.quantity);
        pago += a.paid;
      }
      expect(r.treasuryCash).toBe(pago);
      expect(r.cutPrice).toBeGreaterThanOrEqual(band.floor);
      expect(r.cutPrice).toBeLessThanOrEqual(band.ceiling);
    }
  });
});
