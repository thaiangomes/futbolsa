import { describe, expect, it } from "vitest";
import { Ledger, walletViolations } from "../src/engine/ledger.js";
import { Exchange } from "../src/engine/orderbook.js";
import { validateOrder } from "../src/engine/orderRules.js";

// Caixa negativo por estorno: critérios 12 e 15 do Admin e 17 do livro, e L1 a
// L3 do Plano do núcleo de casamento.

describe("caixa negativo por estorno", () => {
  it("admin 12: o estorno de R$ 400,00 com R$ 150,00 em caixa deixa −R$ 250,00", () => {
    const ledger = new Ledger();
    ledger.open("bruno", 15_000);
    ledger.adjustShares("bruno", "CAM3", 2000);
    ledger.reverseCash("bruno", 40_000);
    expect(ledger.get("bruno").cash).toBe(-25_000);
    expect(walletViolations(ledger.get("bruno"))).toEqual([]);
  });

  it("admin 15: com todo o caixa preso numa compra, o estorno exige cancelar a compra antes", () => {
    const ledger = new Ledger();
    ledger.open("bruno", 50_000);
    ledger.open("ana", 0);
    const ex = new Exchange(ledger, { selfTrade: "reject" });
    ex.setReferencePrice("FLA3", 5000);
    const buy = ex.placeOrder({ accountId: "bruno", clubId: "FLA3", side: "buy", type: "limit", quantity: 10, limitPrice: 5000 });
    expect(ledger.get("bruno").reservedCash).toBe(50_000);
    expect(() => ledger.reverseCash("bruno", 40_000)).toThrow(/cancele/);
    expect(ledger.get("bruno").cash).toBe(50_000);
    ex.cancelOrder(buy.order!.id);
    ledger.reverseCash("bruno", 40_000);
    expect(ledger.get("bruno").cash).toBe(10_000);
  });

  it("o estorno que cabe no caixa livre não precisa cancelar nada", () => {
    const ledger = new Ledger();
    ledger.open("bruno", 50_000);
    ledger.reserveCash("bruno", 10_000);
    ledger.reverseCash("bruno", 40_000);
    expect(ledger.get("bruno")).toMatchObject({ cash: 10_000, reservedCash: 10_000 });
  });

  it("livro 17: com −R$ 250,00, a compra é recusada e a venda executa e leva o caixa a R$ 1.750,00", () => {
    const ledger = new Ledger();
    ledger.open("bruno", 15_000);
    ledger.adjustShares("bruno", "CAM3", 2000);
    ledger.reverseCash("bruno", 40_000);
    ledger.open("carla", 1_000_000);
    const ex = new Exchange(ledger, { selfTrade: "reject" });
    ex.setReferencePrice("CAM3", 2000);
    ex.placeOrder({ accountId: "carla", clubId: "CAM3", side: "buy", type: "limit", quantity: 100, limitPrice: 2000 });

    const state = (side: "buy" | "sell") => ({
      displayedPrice: 2000,
      cash: ledger.get("bruno").cash,
      availableCash: ledger.availableCash("bruno"),
      availableShares: ledger.availableShares("bruno", "CAM3"),
      openOrders: ex.openOrders("bruno").length,
      myOpenOrders: ex.openOrders("bruno", "CAM3").map((o) => ({ side: o.side, limitPrice: o.limitPrice! })),
    });
    expect(validateOrder({ side: "buy", type: "market", quantity: 1 }, state("buy"))).toEqual({ ok: false, code: "negative_cash" });
    // Mesmo sem passar pela validação, a compra a mercado com caixa negativo não executa nada.
    expect(ex.placeOrder({ accountId: "bruno", clubId: "CAM3", side: "buy", type: "market", quantity: 1 }).trades).toEqual([]);

    const v = validateOrder({ side: "sell", type: "market", quantity: 100 }, state("sell"));
    expect(v.ok).toBe(true);
    const r = ex.placeOrder({ accountId: "bruno", clubId: "CAM3", side: "sell", type: "market", quantity: 100, marketPriceLimit: v.ok ? v.marketPriceLimit : undefined });
    expect(r.status).toBe("filled");
    expect(ledger.get("bruno").cash).toBe(175_000);
  });

  it("L1: o dividendo abate o negativo", () => {
    const ledger = new Ledger();
    ledger.open("bruno", 0);
    ledger.reverseCash("bruno", 25_000);
    ledger.adjustCash("bruno", 10_000);
    expect(ledger.get("bruno").cash).toBe(-15_000);
  });

  it("L2: com o caixa negativo, não dá para reservar nem debitar", () => {
    const ledger = new Ledger();
    ledger.open("bruno", 0);
    ledger.reverseCash("bruno", 25_000);
    expect(() => ledger.reserveCash("bruno", 1)).toThrow();
    expect(() => ledger.adjustCash("bruno", -1)).toThrow();
    expect(() => ledger.reverseCash("bruno", 0)).toThrow();
  });

  it("L3: walletViolations aponta cada invariante quebrada", () => {
    const pos = (shares: number, reserved: number) => new Map([["FLA3", { shares, reserved }]]);
    expect(walletViolations({ cash: 100, reservedCash: 50, positions: pos(10, 5) })).toEqual([]);
    expect(walletViolations({ cash: -100, reservedCash: 0, positions: pos(0, 0) })).toEqual([]);
    expect(walletViolations({ cash: -100, reservedCash: 10, positions: new Map() })).toEqual(["caixa abaixo do reservado"]);
    expect(walletViolations({ cash: 10, reservedCash: -1, positions: new Map() })).toContain("caixa reservado negativo");
    expect(walletViolations({ cash: 0, reservedCash: 0, positions: pos(3, 5) })).toEqual(["ações reservadas acima do total de FLA3"]);
  });
});
