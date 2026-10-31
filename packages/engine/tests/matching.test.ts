import { describe, expect, it } from "vitest";
import {
  entryReservation,
  matchOrder,
  remainderRelease,
  selfTradeConflict,
  settlement,
  type BalanceDelta,
  type IncomingOrder,
  type MatchContext,
  type RestingOrder,
} from "../src/engine/matching.js";
import { Rng } from "../src/sim/rng.js";

// Critérios de "Livro de ofertas e formador de mercado" cobertos pelo núcleo de
// casamento puro, e as propriedades N1 a N4 do Plano do núcleo de casamento.

const SKIP: MatchContext = { selfTrade: "skip" };
const REJECT: MatchContext = { selfTrade: "reject" };

const ask = (id: number, accountId: string, quantity: number, price: number): RestingOrder => ({ id, accountId, side: "sell", limitPrice: price, remaining: quantity });
const bid = (id: number, accountId: string, quantity: number, price: number): RestingOrder => ({ id, accountId, side: "buy", limitPrice: price, remaining: quantity });
const limitBuy = (accountId: string, quantity: number, limitPrice: number, id = 100): IncomingOrder => ({ id, accountId, side: "buy", type: "limit", quantity, limitPrice });
const marketBuy = (accountId: string, quantity: number, id = 100): IncomingOrder => ({ id, accountId, side: "buy", type: "market", quantity });
const marketSell = (accountId: string, quantity: number, id = 100): IncomingOrder => ({ id, accountId, side: "sell", type: "market", quantity });

const add = (a: BalanceDelta, b: BalanceDelta): BalanceDelta => ({
  cash: a.cash + b.cash,
  reservedCash: a.reservedCash + b.reservedCash,
  shares: a.shares + b.shares,
  reservedShares: a.reservedShares + b.reservedShares,
});
const ZERO: BalanceDelta = { cash: 0, reservedCash: 0, shares: 0, reservedShares: 0 };

/** Soma o que muda na conta de quem mandou a ordem: reserva, negócios e liberação da sobra. */
function incomingDelta(order: IncomingOrder, opposite: readonly RestingOrder[], ctx: MatchContext): BalanceDelta {
  const r = matchOrder(opposite, order, ctx);
  let d = entryReservation(order);
  for (const f of r.fills) {
    const resting = opposite.find((o) => o.id === f.restingId)!;
    const buy = order.side === "buy" ? { type: order.type, limitPrice: order.limitPrice } : { type: "limit" as const, limitPrice: resting.limitPrice };
    const s = settlement(f, buy);
    d = add(d, order.side === "buy" ? s.buyer : s.seller);
  }
  if (!r.rests) d = add(d, remainderRelease(order, r.remaining));
  return d;
}

describe("núcleo de casamento", () => {
  it("livro 2: prioridade preço-tempo e negócio pelo preço de quem estava no livro", () => {
    // Bruno às 10h00 e Carla às 10h05 a R$ 41,00; Davi às 10h10 a R$ 40,50 (melhor preço primeiro).
    const asks = [ask(3, "davi", 100, 4050), ask(1, "bruno", 100, 4100), ask(2, "carla", 100, 4100)];
    const r = matchOrder(asks, limitBuy("ana", 150, 4100), SKIP);
    expect(r.fills.map((f) => [f.sellerId, f.quantity, f.price])).toEqual([
      ["davi", 100, 4050],
      ["bruno", 50, 4100],
    ]);
    expect(r.status).toBe("filled");
    expect(r.remaining).toBe(0);
  });

  it("livro 3: compra limitada leva a casa e Bruno, paga R$ 2.523,70 e deixa 43 no livro", () => {
    const asks = [ask(1, "casa", 7, 4410), ask(2, "bruno", 50, 4430)];
    const order = limitBuy("ana", 100, 4450);
    const r = matchOrder(asks, order, SKIP);
    expect(r.fills.map((f) => [f.sellerId, f.quantity, f.price])).toEqual([
      ["casa", 7, 4410],
      ["bruno", 50, 4430],
    ]);
    expect(r).toMatchObject({ status: "partial", remaining: 43, rests: true });
    const d = incomingDelta(order, asks, SKIP);
    expect(d.cash).toBe(-252_370); // pagou R$ 2.523,70
    expect(d.reservedCash).toBe(191_350); // 43 × R$ 44,50 continuam presos
    expect(445_000 + (d.cash - d.reservedCash)).toBe(1_280); // de R$ 4.450,00 presos no envio, R$ 12,80 voltam para o livre
    expect(r.fills.at(-1)!.price).toBe(4430); // o preço exibido passa a R$ 44,30
  });

  it("livro 4: compra a mercado vai até o caixa livre e o resto é cancelado", () => {
    const asks = [ask(1, "bruno", 100, 3000)];
    const order = marketBuy("ana", 50);
    const r = matchOrder(asks, order, { ...SKIP, availableCash: 100_000 });
    expect(r.fills.map((f) => [f.quantity, f.price])).toEqual([[33, 3000]]);
    expect(r).toMatchObject({ status: "partial", remaining: 17, rests: false });
    expect(incomingDelta(order, asks, { ...SKIP, availableCash: 100_000 })).toEqual({ ...ZERO, cash: -99_000, shares: 33 });
  });

  it("livro 5: venda a mercado executa o que há e as ações que sobram voltam a ficar livres", () => {
    const bids = [bid(1, "bruno", 70, 4000), bid(2, "carla", 50, 3950)];
    const order = marketSell("ana", 200);
    const r = matchOrder(bids, order, SKIP);
    expect(r.fills.reduce((s, f) => s + f.quantity, 0)).toBe(120);
    expect(r).toMatchObject({ status: "partial", remaining: 80, rests: false });
    // Reservou 200, vendeu 120 e liberou 80: nada fica reservado.
    expect(incomingDelta(order, bids, SKIP)).toEqual({ cash: 70 * 4000 + 50 * 3950, reservedCash: 0, shares: -120, reservedShares: 0 });
  });

  it("livro 7: compra a mercado não executa acima do limite de 20% calculado no envio", () => {
    const asks = [ask(1, "bruno", 50, 4700), ask(2, "carla", 100, 4900)];
    const r = matchOrder(asks, marketBuy("ana", 120), { ...SKIP, availableCash: 10_000_000, marketPriceLimit: 4800 });
    expect(r.fills.map((f) => [f.quantity, f.price])).toEqual([[50, 4700]]);
    expect(r).toMatchObject({ status: "partial", remaining: 70, rests: false });
  });

  it("venda a mercado não executa abaixo do piso de 20%", () => {
    const bids = [bid(1, "bruno", 10, 3300), bid(2, "carla", 10, 3100)];
    const r = matchOrder(bids, marketSell("ana", 20), { ...SKIP, marketPriceLimit: 3200 });
    expect(r.fills.map((f) => [f.quantity, f.price])).toEqual([[10, 3300]]);
    expect(r.remaining).toBe(10);
  });

  it("livro 12: compra limitada executa contra a casa pelo preço da casa", () => {
    const asks = [ask(1, "casa", 7, 5700), ask(2, "bruno", 10, 6000)];
    const r = matchOrder(asks, limitBuy("ana", 5, 5800), SKIP);
    expect(r.fills.map((f) => [f.sellerId, f.quantity, f.price])).toEqual([["casa", 5, 5700]]);
  });

  it("livro 13: no modo reject, ordem que cruzaria com uma ordem própria é recusada", () => {
    const asks = [ask(1, "ana", 10, 4200), ask(2, "bruno", 10, 4300)];
    for (const order of [limitBuy("ana", 5, 4200), marketBuy("ana", 5)]) {
      expect(matchOrder(asks, order, { ...REJECT, availableCash: 1_000_000 })).toEqual({ status: "rejected", reason: "self_trade", fills: [], remaining: 5, rests: false });
    }
    const ok = matchOrder(asks, limitBuy("ana", 5, 4199), REJECT);
    expect(ok).toMatchObject({ status: "resting", fills: [], remaining: 5, rests: true });
  });

  it("no modo skip (simulação), as ordens da própria conta são puladas", () => {
    const asks = [ask(1, "ana", 10, 4200), ask(2, "bruno", 10, 4250)];
    const r = matchOrder(asks, limitBuy("ana", 5, 4300), SKIP);
    expect(r.fills.map((f) => [f.sellerId, f.price])).toEqual([["bruno", 4250]]);
  });

  it("selfTradeConflict: compra igual ou acima de uma venda minha, venda igual ou abaixo de uma compra minha, a mercado com qualquer ordem minha do outro lado", () => {
    const mine = [ask(1, "ana", 10, 4200)];
    expect(selfTradeConflict(limitBuy("ana", 1, 4200), mine)).toBe(true);
    expect(selfTradeConflict(limitBuy("ana", 1, 4199), mine)).toBe(false);
    expect(selfTradeConflict(marketBuy("ana", 1), mine)).toBe(true);
    expect(selfTradeConflict(marketBuy("ana", 1), [])).toBe(false);
    const myBid = [bid(1, "ana", 10, 4000)];
    expect(selfTradeConflict({ id: 9, accountId: "ana", side: "sell", type: "limit", quantity: 1, limitPrice: 4000 }, myBid)).toBe(true);
    expect(selfTradeConflict({ id: 9, accountId: "ana", side: "sell", type: "limit", quantity: 1, limitPrice: 4001 }, myBid)).toBe(false);
    expect(selfTradeConflict(marketSell("ana", 1), myBid)).toBe(true);
  });

  it("compra a mercado com caixa livre negativo não executa nada", () => {
    const r = matchOrder([ask(1, "bruno", 10, 2000)], marketBuy("ana", 1), { ...SKIP, availableCash: -25_000 });
    expect(r).toMatchObject({ status: "cancelled", fills: [], remaining: 1 });
  });

  it("N1: não muda o que recebe", () => {
    const asks = Object.freeze([Object.freeze(ask(1, "casa", 7, 4410)), Object.freeze(ask(2, "bruno", 50, 4430))]);
    const order = Object.freeze(limitBuy("ana", 100, 4450));
    expect(() => matchOrder(asks, order, SKIP)).not.toThrow();
    expect(asks.map((o) => o.remaining)).toEqual([7, 50]);
  });

  it("N4: livro fora da ordem de prioridade lança erro", () => {
    expect(() => matchOrder([ask(1, "b", 1, 4100), ask(2, "c", 1, 4000)], limitBuy("ana", 2, 4200), SKIP)).toThrow(/ordem/);
    expect(() => matchOrder([ask(2, "b", 1, 4000), ask(1, "c", 1, 4000)], limitBuy("ana", 2, 4200), SKIP)).toThrow(/ordem/);
    expect(() => matchOrder([bid(1, "b", 1, 4000), bid(2, "c", 1, 4100)], marketSell("ana", 2), SKIP)).toThrow(/ordem/);
  });

  it("N2 e N3: em livros sorteados, nada executa além do que há e todo negócio respeita os limites", () => {
    const rng = new Rng(7);
    for (let round = 0; round < 2000; round++) {
      const side = rng.chance(0.5) ? "buy" : "sell";
      const accounts = ["ana", "bia", "caio", "duda"];
      const n = rng.int(0, 8);
      const opposite: RestingOrder[] = Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        accountId: accounts[rng.int(0, 3)]!,
        side: side === "buy" ? "sell" : "buy",
        limitPrice: rng.int(950, 1050),
        remaining: rng.int(1, 30),
      }));
      opposite.sort((a, b) => (side === "buy" ? a.limitPrice - b.limitPrice : b.limitPrice - a.limitPrice) || a.id - b.id);
      const type = rng.chance(0.5) ? "limit" : "market";
      const order: IncomingOrder = {
        id: 1000,
        accountId: accounts[rng.int(0, 3)]!,
        side,
        type,
        quantity: rng.int(1, 60),
        limitPrice: type === "limit" ? rng.int(950, 1050) : undefined,
      };
      const ctx: MatchContext = {
        selfTrade: rng.chance(0.5) ? "skip" : "reject",
        availableCash: rng.int(-500, 40_000),
        marketPriceLimit: type === "market" && rng.chance(0.5) ? rng.int(950, 1050) : undefined,
      };
      const r = matchOrder(opposite, order, ctx);
      const filled = r.fills.reduce((s, f) => s + f.quantity, 0);
      expect(filled + r.remaining).toBe(order.quantity);
      for (const o of opposite) {
        expect(r.fills.filter((f) => f.restingId === o.id).reduce((s, f) => s + f.quantity, 0)).toBeLessThanOrEqual(o.remaining);
      }
      let spent = 0;
      for (const f of r.fills) {
        const resting = opposite.find((o) => o.id === f.restingId)!;
        expect(f.price).toBe(resting.limitPrice);
        expect(resting.accountId).not.toBe(order.accountId);
        expect(f.quantity).toBeGreaterThan(0);
        if (type === "limit") expect(side === "buy" ? f.price <= order.limitPrice! : f.price >= order.limitPrice!).toBe(true);
        if (ctx.marketPriceLimit !== undefined) expect(side === "buy" ? f.price <= ctx.marketPriceLimit : f.price >= ctx.marketPriceLimit).toBe(true);
        spent += f.price * f.quantity;
      }
      if (type === "market" && side === "buy") expect(spent).toBeLessThanOrEqual(Math.max(0, ctx.availableCash!));
      if (r.status === "rejected") expect(r.fills).toEqual([]);
    }
  });
});
