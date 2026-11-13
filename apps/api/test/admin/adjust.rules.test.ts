import { describe, expect, it } from "vitest";
import { adjustPlan, type AdjustInput } from "../../src/modules/admin/players/adjust.rules.js";

const base: AdjustInput = {
  asset: "cash",
  delta: 0,
  seasonStatus: "trading",
  wallet: { cash: 10_000, reservedCash: 0 },
  position: null,
  treasuryPosition: null,
  price: 4000,
};

describe("F14, T5: adjustPlan (regra pura do ajuste de saldo)", () => {
  it("admin 27: com 50 FLA3 livres na tesouraria, creditar 100 é recusado e creditar 30 deixa 20", () => {
    const input: AdjustInput = { ...base, asset: "shares", treasuryPosition: { shares: 50, reservedShares: 0 } };
    expect(adjustPlan({ ...input, delta: 100 })).toEqual({ ok: false, code: "treasury_insufficient_shares" });
    const plan = adjustPlan({ ...input, delta: 30 });
    expect(plan).toEqual({
      ok: true,
      movements: [
        { owner: "player", sharesDelta: 30, costBasis: "purchase", price: 4000 },
        { owner: "treasury", sharesDelta: -30, costBasis: "debit" },
      ],
    });
  });

  it("admin 27: as ações presas nas cotações da casa não contam como livres da tesouraria", () => {
    const input: AdjustInput = { ...base, asset: "shares", treasuryPosition: { shares: 50, reservedShares: 40 } };
    expect(adjustPlan({ ...input, delta: 11 })).toEqual({ ok: false, code: "treasury_insufficient_shares" });
    expect(adjustPlan({ ...input, delta: 10 }).ok).toBe(true);
  });

  it("admin 28: com R$ 100,00 em caixa, debitar R$ 150,00 é recusado", () => {
    const input: AdjustInput = { ...base, wallet: { cash: 10_000, reservedCash: 0 } };
    expect(adjustPlan({ ...input, delta: -15_000 })).toEqual({ ok: false, code: "adjust_insufficient_cash" });
    expect(adjustPlan({ ...input, delta: -10_000 }).ok).toBe(true);
  });

  it("débito de caixa reservado é recusado: R$ 100,00 com R$ 80,00 reservados, R$ 50,00 recusa e R$ 20,00 passa", () => {
    const input: AdjustInput = { ...base, wallet: { cash: 10_000, reservedCash: 8000 } };
    expect(adjustPlan({ ...input, delta: -5000 })).toEqual({ ok: false, code: "adjust_insufficient_cash" });
    expect(adjustPlan({ ...input, delta: -2000 }).ok).toBe(true);
  });

  it("crédito a quem tem caixa negativo passa e só diminui a dívida; débito a ele é recusado", () => {
    const input: AdjustInput = { ...base, wallet: { cash: -25_000, reservedCash: 0 } };
    expect(adjustPlan({ ...input, delta: 10_000 })).toEqual({ ok: true, movements: [{ owner: "player", cashDelta: 10_000 }] });
    expect(adjustPlan({ ...input, delta: -1 })).toEqual({ ok: false, code: "adjust_insufficient_cash" });
  });

  it("débito de ações: só as livres do jogador; o custo sai sem resultado e a tesouraria recebe pelo preço exibido", () => {
    const input: AdjustInput = { ...base, asset: "shares", position: { shares: 10, reservedShares: 6 } };
    expect(adjustPlan({ ...input, delta: -5 })).toEqual({ ok: false, code: "adjust_insufficient_shares" });
    expect(adjustPlan({ ...input, delta: -4 })).toEqual({
      ok: true,
      movements: [
        { owner: "player", sharesDelta: -4, costBasis: "debit" },
        { owner: "treasury", sharesDelta: 4, costBasis: "purchase", price: 4000 },
      ],
    });
  });

  it("proposta 8: ações só em trading; caixa de ipo_open a trading_ended; fora disso, adjust_not_allowed", () => {
    const shares: AdjustInput = { ...base, asset: "shares", delta: 1, treasuryPosition: { shares: 5, reservedShares: 0 } };
    for (const status of ["preparing", "ipo_open", "ipo_closed", "trading_ended", "closed"] as const) {
      expect(adjustPlan({ ...shares, seasonStatus: status }), `ações em ${status}`).toEqual({ ok: false, code: "adjust_not_allowed" });
    }
    for (const status of ["ipo_open", "ipo_closed", "trading", "trading_ended"] as const) {
      expect(adjustPlan({ ...base, delta: 100, seasonStatus: status }).ok, `caixa em ${status}`).toBe(true);
    }
    for (const status of ["preparing", "closed"] as const) {
      expect(adjustPlan({ ...base, delta: 100, seasonStatus: status }), `caixa em ${status}`).toEqual({ ok: false, code: "adjust_not_allowed" });
    }
  });
});
