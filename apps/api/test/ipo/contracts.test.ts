import { describe, expect, it } from "vitest";
import {
  IPO_ERROR_MESSAGES,
  deleteBidResponseSchema,
  ipoOverviewSchema,
  ipoResultsSchema,
  patchSeasonBodySchema,
  putBidBodySchema,
  putBidResponseSchema,
  tickerParamSchema,
} from "@futbolsa/contracts";

const cash = { total: 10_000_000, reserved: 6_000_000, free: 4_000_000 };
const myBid = { quantity: 1500, maxPrice: 4000, reserved: 6_000_000, updatedAt: "2027-03-29T12:00:00.000Z" };
const band = { floor: 3033, center: 5055, ceiling: 7077, placementPrice: 4000, cupsPart: 1055 };

describe("contratos do IPO", () => {
  it("ipo 15: a visão do IPO não aceita demanda, número de ofertas nem ofertas dos outros (esquema estrito)", () => {
    const base = {
      status: "ipo_open" as const,
      offerSize: 3000,
      opensAt: "2027-03-28T19:00:00.000Z",
      closesAt: "2027-04-04T19:00:00.000Z",
      tradingOpensAt: "2027-04-05T13:00:00.000Z",
      clubs: [{ ticker: "FLA3", name: "Flamengo", band, myBid }],
      cash,
    };
    expect(ipoOverviewSchema.safeParse(base).success).toBe(true);
    expect(ipoOverviewSchema.safeParse({ ...base, demand: 4500 }).success).toBe(false);
    expect(ipoOverviewSchema.safeParse({ ...base, bidCount: 12 }).success).toBe(false);
    expect(
      ipoOverviewSchema.safeParse({ ...base, clubs: [{ ...base.clubs[0], demand: 4500 }] }).success,
    ).toBe(false);
    expect(
      ipoOverviewSchema.safeParse({ ...base, clubs: [{ ...base.clubs[0], bids: [myBid] }] }).success,
    ).toBe(false);
  });

  it("antes da abertura só vêm as datas previstas, sem clubes e sem caixa de quem não tem carteira", () => {
    const parsed = ipoOverviewSchema.safeParse({
      status: "preparing",
      offerSize: null,
      opensAt: null,
      closesAt: null,
      tradingOpensAt: null,
      clubs: [],
      cash: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("o corpo do PUT pede quantidade, preço e o que se espera (new ou existing); o motor confere os valores", () => {
    expect(putBidBodySchema.safeParse({ quantity: 10, maxPrice: 4000, expect: "new" }).success).toBe(true);
    expect(putBidBodySchema.safeParse({ quantity: 10, maxPrice: 4000, expect: "existing" }).success).toBe(true);
    expect(putBidBodySchema.safeParse({ quantity: 10, maxPrice: 4000 }).success).toBe(false);
    expect(putBidBodySchema.safeParse({ quantity: 10, maxPrice: 4000, expect: "talvez" }).success).toBe(false);
    expect(putBidBodySchema.safeParse({ quantity: 10, maxPrice: 4000, expect: "new", extra: 1 }).success).toBe(false);
    // quantidade e preço absurdos passam pelo esquema: viram invalid_quantity e invalid_price no motor
    expect(putBidBodySchema.safeParse({ quantity: 0, maxPrice: 40.5, expect: "new" }).success).toBe(true);
  });

  it("as respostas do PUT e do DELETE trazem a oferta e o caixa", () => {
    expect(putBidResponseSchema.safeParse({ ticker: "FLA3", bid: myBid, cash }).success).toBe(true);
    expect(deleteBidResponseSchema.safeParse({ ticker: "FLA3", cash }).success).toBe(true);
    expect(deleteBidResponseSchema.safeParse({ ticker: "FLA3", cash, bid: myBid }).success).toBe(false);
  });

  it("o ticker da rota tem três letras e um número", () => {
    expect(tickerParamSchema.safeParse("FLA3").success).toBe(true);
    for (const t of ["fla3", "FLA", "FLAM3", "FLA33", ""]) expect(tickerParamSchema.safeParse(t).success).toBe(false);
  });

  it("ipo 24: o resultado é pending, settling ou settled com o corte, a demanda, a fração, a sobra e as minhas ações", () => {
    expect(ipoResultsSchema.safeParse({ status: "pending" }).success).toBe(true);
    expect(ipoResultsSchema.safeParse({ status: "settling" }).success).toBe(true);
    const club = {
      ticker: "FLA3",
      name: "Flamengo",
      cutPrice: 3500,
      demandAtCut: 4500,
      ratio: { num: 2, den: 3 },
      leftoverShares: 0,
      lotShares: 600,
      myAllocation: { shares: 1000, paid: 3_500_000, refunded: 2_500_000 },
    };
    expect(ipoResultsSchema.safeParse({ status: "settled", clubs: [club] }).success).toBe(true);
    expect(ipoResultsSchema.safeParse({ status: "settled", clubs: [{ ...club, myAllocation: null }] }).success).toBe(true);
    expect(ipoResultsSchema.safeParse({ status: "settling", clubs: [club] }).success).toBe(false);
  });

  it("todo código de erro tem mensagem em português e nenhuma cita demanda ou ofertas de outros", () => {
    for (const message of Object.values(IPO_ERROR_MESSAGES)) {
      expect(message.length).toBeGreaterThan(10);
      expect(message.toLowerCase()).not.toMatch(/demanda|outros jogadores/);
    }
  });

  it("admin 20: o PATCH da temporada aceita o novo fechamento do IPO, sozinho ou com motivo", () => {
    expect(patchSeasonBodySchema.safeParse({ ipoClosesAt: "2027-04-06T19:00:00Z" }).success).toBe(true);
    expect(patchSeasonBodySchema.safeParse({ ipoClosesAt: "2027-04-06T19:00:00Z", reason: "mais um dia" }).success).toBe(true);
    expect(patchSeasonBodySchema.safeParse({ ipoClosesAt: "amanhã" }).success).toBe(false);
    expect(patchSeasonBodySchema.safeParse({}).success).toBe(false);
  });
});
