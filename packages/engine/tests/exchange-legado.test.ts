import { describe, expect, it } from "vitest";
import { Ledger } from "../src/engine/ledger.js";
import { Exchange, type OrderRequest } from "../src/engine/orderbook.js";
import { Rng } from "../src/sim/rng.js";
import { LegacyExchange } from "./support/legado/orderbook.js";

// R2 do Plano do núcleo de casamento: o Exchange por cima do núcleo puro dá os
// mesmos resultados, negócios e saldos que o Exchange da Fase 0, com ordens
// sorteadas. E os critérios 1, 16 e 30 do livro, que dependem do livro em memória.

const ACCOUNTS = ["ana", "bia", "caio", "duda", "casa"];
const CLUBS = ["FLA3", "PAL3"];

function snapshot(ledger: Ledger) {
  return ledger.all().map((a) => ({
    id: a.id,
    cash: a.cash,
    reservedCash: a.reservedCash,
    positions: [...a.positions].sort(([x], [y]) => x.localeCompare(y)),
  }));
}

function freshLedger(): Ledger {
  const ledger = new Ledger();
  for (const id of ACCOUNTS) {
    ledger.open(id, 200_000);
    for (const c of CLUBS) ledger.adjustShares(id, c, 200);
  }
  return ledger;
}

function makePair(rng: Rng) {
  const options = { houseAccounts: ["casa"], houseTradesSetPrice: rng.chance(0.5) };
  const now = { ledger: freshLedger() } as { ledger: Ledger; ex: Exchange | LegacyExchange };
  const old = { ledger: freshLedger() } as { ledger: Ledger; ex: Exchange | LegacyExchange };
  now.ex = new Exchange(now.ledger, options);
  old.ex = new LegacyExchange(old.ledger, options);
  for (const c of CLUBS) {
    now.ex.setReferencePrice(c, 1000);
    old.ex.setReferencePrice(c, 1000);
  }
  return { now, old };
}

describe("Exchange × Exchange da Fase 0", () => {
  it("R2: 200 sementes × 300 operações sorteadas dão os mesmos resultados, negócios e saldos", () => {
    let totalTrades = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rng = new Rng(seed);
      const { now, old } = makePair(rng);
      const tradesNow: unknown[] = [];
      const tradesOld: unknown[] = [];
      now.ex.onTrade((t) => tradesNow.push({ ...t }));
      old.ex.onTrade((t) => tradesOld.push({ ...t }));
      let lastId = 0;
      for (let step = 0; step < 300; step++) {
        now.ex.setTime(step);
        old.ex.setTime(step);
        if (lastId > 0 && rng.chance(0.15)) {
          const id = rng.int(1, lastId);
          expect(now.ex.cancelOrder(id)).toBe(old.ex.cancelOrder(id));
        } else {
          const type = rng.chance(0.3) ? "market" : "limit";
          const req: OrderRequest = {
            accountId: ACCOUNTS[rng.int(0, ACCOUNTS.length - 1)]!,
            clubId: CLUBS[rng.int(0, CLUBS.length - 1)]!,
            side: rng.chance(0.5) ? "buy" : "sell",
            type,
            quantity: rng.chance(0.03) ? 0 : rng.int(1, 40),
            limitPrice: type === "limit" ? (rng.chance(0.02) ? 40 : rng.int(960, 1040)) : undefined,
          };
          const a = JSON.stringify(now.ex.placeOrder(req));
          const b = JSON.stringify(old.ex.placeOrder(req));
          if (a !== b) expect(a).toBe(b);
          const id = JSON.parse(a).order?.id;
          if (id) lastId = id;
        }
        // Comparar como texto é bem mais barato que um expect por passo.
        const sa = JSON.stringify(snapshot(now.ledger));
        const sb = JSON.stringify(snapshot(old.ledger));
        if (sa !== sb) expect(sa).toBe(sb);
      }
      expect(tradesNow).toEqual(tradesOld);
      totalTrades += tradesNow.length;
      for (const c of CLUBS) {
        expect(now.ex.price(c)).toBe(old.ex.price(c));
        expect(JSON.stringify(now.ex.depth(c))).toBe(JSON.stringify(old.ex.depth(c)));
      }
    }
    // Sanidade: as ordens sorteadas cruzam bastante.
    expect(totalTrades).toBeGreaterThan(5000);
  }, 60_000);
});

describe("Exchange no modo do jogo", () => {
  const setup = () => {
    const ledger = new Ledger();
    for (const id of ["ana", "bruno"]) {
      ledger.open(id, 1_000_000); // R$ 10.000,00
      ledger.adjustShares(id, "FLA3", 1000);
    }
    const ex = new Exchange(ledger, { selfTrade: "reject" });
    ex.setReferencePrice("FLA3", 4000);
    return { ledger, ex };
  };

  it("livro 1: compra limitada sem contraparte fica no livro e reserva R$ 4.000,00", () => {
    const { ledger, ex } = setup();
    const r = ex.placeOrder({ accountId: "ana", clubId: "FLA3", side: "buy", type: "limit", quantity: 100, limitPrice: 4000 });
    expect(r.status).toBe("resting");
    expect(ledger.get("ana").reservedCash).toBe(400_000);
    expect(ledger.availableCash("ana")).toBe(600_000);
  });

  it("livro 13: ordem contra si mesmo é recusada e nada muda", () => {
    const { ledger, ex } = setup();
    ex.placeOrder({ accountId: "ana", clubId: "FLA3", side: "sell", type: "limit", quantity: 10, limitPrice: 4200 });
    const before = snapshot(ledger);
    expect(ex.placeOrder({ accountId: "ana", clubId: "FLA3", side: "buy", type: "limit", quantity: 1, limitPrice: 4200 }).status).toBe("rejected");
    expect(ex.placeOrder({ accountId: "ana", clubId: "FLA3", side: "buy", type: "market", quantity: 1 }).status).toBe("rejected");
    expect(snapshot(ledger)).toEqual(before);
    expect(ex.placeOrder({ accountId: "ana", clubId: "FLA3", side: "buy", type: "limit", quantity: 1, limitPrice: 4199 }).status).toBe("resting");
  });

  it("livro 7: a compra a mercado para no limite de preço e o resto é cancelado", () => {
    const { ledger, ex } = setup();
    ex.placeOrder({ accountId: "bruno", clubId: "FLA3", side: "sell", type: "limit", quantity: 50, limitPrice: 4700 });
    ex.placeOrder({ accountId: "bruno", clubId: "FLA3", side: "sell", type: "limit", quantity: 100, limitPrice: 4900 });
    const r = ex.placeOrder({ accountId: "ana", clubId: "FLA3", side: "buy", type: "market", quantity: 120, marketPriceLimit: 4800 });
    expect(r.trades.map((t) => [t.quantity, t.price])).toEqual([[50, 4700]]);
    expect(r.status).toBe("partial");
    expect(ledger.shares("ana", "FLA3")).toBe(1050);
  });

  it("livro 16: cancelar uma venda de 500 devolve as ações e tira a ordem do livro", () => {
    const { ledger, ex } = setup();
    const r = ex.placeOrder({ accountId: "ana", clubId: "FLA3", side: "sell", type: "limit", quantity: 500, limitPrice: 4100 });
    expect(ledger.availableShares("ana", "FLA3")).toBe(500);
    expect(ex.cancelOrder(r.order!.id)).toBe(true);
    expect(ledger.availableShares("ana", "FLA3")).toBe(1000);
    expect(ex.bestAsk("FLA3")).toBeUndefined();
  });

  it("livro 30: em qualquer sequência de negócios, as ações e o dinheiro se conservam", () => {
    const rng = new Rng(30);
    const ledger = new Ledger();
    const ids = ["ana", "bruno", "carla", "casa"];
    for (const id of ids) {
      ledger.open(id, 500_000);
      ledger.adjustShares(id, "FLA3", 300);
    }
    const ex = new Exchange(ledger, { houseAccounts: ["casa"], selfTrade: "reject" });
    ex.setReferencePrice("FLA3", 1000);
    for (let i = 0; i < 2000; i++) {
      const type = rng.chance(0.3) ? "market" : "limit";
      ex.placeOrder({
        accountId: ids[rng.int(0, 3)]!,
        clubId: "FLA3",
        side: rng.chance(0.5) ? "buy" : "sell",
        type,
        quantity: rng.int(1, 30),
        limitPrice: type === "limit" ? rng.int(950, 1050) : undefined,
      });
      expect(ledger.totalShares("FLA3")).toBe(1200);
      expect(ledger.totalCash()).toBe(2_000_000);
      for (const a of ledger.all()) {
        expect(a.reservedCash).toBeGreaterThanOrEqual(0);
        expect(a.cash).toBeGreaterThanOrEqual(a.reservedCash);
      }
    }
  });
});
