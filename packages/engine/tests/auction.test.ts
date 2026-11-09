import { describe, expect, it } from "vitest";
import { clearAuction, type AuctionOrder, type AuctionResult } from "../src/engine/auction.js";
import { reais } from "../src/engine/money.js";

// Critérios 40 e 42 de "Livro de ofertas e formador de mercado" (fim do leilão: preço único) e a decisão D3 do
// Plano do livro de ofertas e formador (empate depois da distância da referência fica com o menor preço).

const buy = (id: number, accountId: string, quantity: number, price: number): AuctionOrder => ({ id, accountId, side: "buy", limitPrice: price, remaining: quantity });
const sell = (id: number, accountId: string, quantity: number, price: number): AuctionOrder => ({ id, accountId, side: "sell", limitPrice: price, remaining: quantity });

describe("clearAuction: critérios", () => {
  it("livro 40: preço único de R$ 44,50 com 100 ações", () => {
    // Bruno e Davi já estavam no livro; Ana abriu o leilão; Carla entrou nele; a casa repôs às 15h.
    const orders = [
      sell(1, "bruno", 50, reais(43)),
      sell(2, "davi", 100, reais(44.5)),
      buy(3, "ana", 100, reais(45)),
      buy(4, "carla", 30, reais(42)),
      sell(5, "casa", 10, reais(44.1)),
    ];
    const r = clearAuction(orders, reais(40));
    // R$ 45,00 também negocia 100 com sobra de 60, mas fica R$ 5,00 longe da referência (R$ 44,50 fica a R$ 4,50).
    expect(r.price).toBe(reais(44.5));
    expect(r.volume).toBe(100);
    expect(r.fills).toEqual([
      { buyOrderId: 3, sellOrderId: 1, buyerId: "ana", sellerId: "bruno", price: reais(44.5), quantity: 50 },
      { buyOrderId: 3, sellOrderId: 5, buyerId: "ana", sellerId: "casa", price: reais(44.5), quantity: 10 },
      { buyOrderId: 3, sellOrderId: 2, buyerId: "ana", sellerId: "davi", price: reais(44.5), quantity: 40 },
    ]);
    // Ana paga R$ 4.450,00.
    expect(r.fills.reduce((s, f) => s + f.price * f.quantity, 0)).toBe(reais(4450));
    expect(r.remaining).toEqual(
      new Map([
        [1, 0],
        [2, 60],
        [3, 0],
        [4, 30],
        [5, 0],
      ]),
    );
  });

  it("livro 42: com compras até R$ 38,00 e vendas a partir de R$ 39,00 não sai negócio", () => {
    const orders = [buy(1, "carla", 30, reais(38)), buy(2, "edu", 20, reais(37)), sell(3, "bruno", 50, reais(39)), sell(4, "davi", 100, reais(44.5))];
    const r = clearAuction(orders, reais(40));
    expect(r.price).toBeNull();
    expect(r.volume).toBe(0);
    expect(r.fills).toEqual([]);
    expect(r.remaining).toEqual(
      new Map([
        [1, 30],
        [2, 20],
        [3, 50],
        [4, 100],
      ]),
    );
  });
});

describe("clearAuction: desempates", () => {
  it("D3: empate também na distância da referência fica com o menor preço", () => {
    // R$ 39,00 e R$ 41,00 negociam 10 com sobra 0 e ficam a R$ 1,00 da referência de R$ 40,00. Os candidatos são
    // os preços limite das ordens: R$ 40,00 não é limite de ninguém e não entra.
    const r = clearAuction([buy(1, "ana", 10, reais(41)), sell(2, "bruno", 10, reais(39))], reais(40));
    expect(r.price).toBe(reais(39));
    expect(r.fills).toEqual([{ buyOrderId: 1, sellOrderId: 2, buyerId: "ana", sellerId: "bruno", price: reais(39), quantity: 10 }]);
  });

  it("D3: também com mais ordens dos dois lados", () => {
    // R$ 39,00: compra 15, venda 10 → 10, sobra 5. R$ 41,00: compra 10, venda 15 → 10, sobra 5. Ambos a R$ 1,00.
    const orders = [buy(1, "ana", 10, reais(41)), buy(2, "carla", 5, reais(39)), sell(3, "bruno", 10, reais(39)), sell(4, "davi", 5, reais(41))];
    const r = clearAuction(orders, reais(40));
    expect(r.price).toBe(reais(39));
    expect(r.volume).toBe(10);
  });

  it("empate na quantidade fica com a menor sobra, mesmo mais longe da referência", () => {
    // R$ 38,00 e R$ 40,00: compra 15, venda 10 → 10, sobra 5. R$ 41,00 e R$ 42,00: compra 10, venda 13 → 10,
    // sobra 3. A referência é R$ 38,00, mas a menor sobra vem antes; entre R$ 41,00 e R$ 42,00, o mais perto.
    const orders = [buy(1, "ana", 10, reais(42)), buy(2, "carla", 5, reais(40)), sell(3, "bruno", 10, reais(38)), sell(4, "davi", 3, reais(41))];
    const r = clearAuction(orders, reais(38));
    expect(r.price).toBe(reais(41));
    expect(r.volume).toBe(10);
    expect(r.fills).toEqual([{ buyOrderId: 1, sellOrderId: 3, buyerId: "ana", sellerId: "bruno", price: reais(41), quantity: 10 }]);
    expect(r.remaining.get(2)).toBe(5);
    expect(r.remaining.get(4)).toBe(3);
  });

  it("maior quantidade vence a distância da referência", () => {
    // R$ 40,00 e R$ 41,00 negociam 10; R$ 44,00 e R$ 45,00 negociam 20 (sobra 10 nos dois; R$ 44,00 mais perto).
    const orders = [buy(1, "ana", 10, reais(41)), buy(2, "carla", 20, reais(45)), sell(3, "bruno", 10, reais(40)), sell(4, "davi", 20, reais(44))];
    const r = clearAuction(orders, reais(40));
    expect(r.price).toBe(reais(44));
    expect(r.volume).toBe(20);
    expect(r.fills).toEqual([
      { buyOrderId: 2, sellOrderId: 3, buyerId: "carla", sellerId: "bruno", price: reais(44), quantity: 10 },
      { buyOrderId: 2, sellOrderId: 4, buyerId: "carla", sellerId: "davi", price: reais(44), quantity: 10 },
    ]);
  });

  it("no mesmo preço limite, a ordem que chegou antes casa primeiro", () => {
    const orders = [sell(7, "davi", 10, reais(40)), sell(3, "bruno", 10, reais(40)), buy(9, "ana", 15, reais(40)), buy(5, "carla", 15, reais(40))];
    const r = clearAuction(orders, reais(40));
    expect(r.price).toBe(reais(40));
    expect(r.fills.map((f) => [f.buyOrderId, f.sellOrderId, f.quantity])).toEqual([
      [5, 3, 10],
      [5, 7, 5],
      [9, 7, 5],
    ]);
    expect(r.remaining.get(9)).toBe(10);
  });

  it("sem ordens, ou com um lado só, não sai negócio", () => {
    expect(clearAuction([], reais(40)).price).toBeNull();
    expect(clearAuction([buy(1, "ana", 10, reais(45))], reais(40)).fills).toEqual([]);
    expect(clearAuction([sell(1, "bruno", 10, reais(35))], reais(40)).price).toBeNull();
  });
});

describe("clearAuction: entradas recusadas", () => {
  it("recusa quantidade zero, negativa ou fracionada", () => {
    expect(() => clearAuction([buy(1, "ana", 0, reais(40))], reais(40))).toThrow();
    expect(() => clearAuction([buy(1, "ana", -5, reais(40))], reais(40))).toThrow();
    expect(() => clearAuction([sell(1, "ana", 1.5, reais(40))], reais(40))).toThrow();
  });

  it("recusa preço que não é inteiro em centavos, preço zero e referência fracionada", () => {
    expect(() => clearAuction([buy(1, "ana", 10, 4000.5)], reais(40))).toThrow();
    expect(() => clearAuction([sell(1, "ana", 10, 0)], reais(40))).toThrow();
    expect(() => clearAuction([buy(1, "ana", 10, reais(40))], 4000.5)).toThrow();
  });

  it("recusa id repetido", () => {
    expect(() => clearAuction([buy(1, "ana", 10, reais(40)), sell(1, "bruno", 10, reais(40))], reais(40))).toThrow();
  });

  it("não mexe nas ordens recebidas", () => {
    const orders = [buy(1, "ana", 10, reais(41)), sell(2, "bruno", 10, reais(39))];
    const copy = structuredClone(orders);
    clearAuction(orders, reais(40));
    expect(orders).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Propriedades com ordens sorteadas, contra uma busca por força bruta.

/** Gerador simples e determinístico (mulberry32), próprio do teste. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rnd: () => number, min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

function shuffle<T>(rnd: () => number, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function randomScenario(rnd: () => number): { orders: AuctionOrder[]; reference: number } {
  const reference = randInt(rnd, 500, 8000);
  const n = randInt(rnd, 0, 16);
  // Ids crescentes com buracos, entregues fora de ordem.
  const ids = shuffle(
    rnd,
    Array.from({ length: n }, (_, i) => i * 3 + randInt(rnd, 1, 3)),
  );
  // Poucos degraus de preço, para forçar empates; às vezes um preço quebrado em centavos.
  const step = randInt(rnd, 1, 4) * 25;
  const orders = ids.map((id) => {
    const side = rnd() < 0.5 ? "buy" : "sell";
    const offset = randInt(rnd, -6, 6) * step + (rnd() < 0.2 ? randInt(rnd, -20, 20) : 0);
    const limitPrice = Math.max(1, reference + offset);
    // Compradores e vendedores são contas diferentes (precondição: ninguém cruza consigo mesmo).
    const accountId = `${side === "buy" ? "c" : "v"}${randInt(rnd, 1, 4)}`;
    return { id, accountId, side, limitPrice, remaining: randInt(rnd, 1, 50) } satisfies AuctionOrder;
  });
  return { orders, reference };
}

/**
 * Força bruta, independente da função: varre todos os preços inteiros entre o menor e o maior limite, conta a
 * demanda e a oferta direto nas ordens, e escolhe pelos mesmos critérios entre os preços que são limite de
 * alguma ordem. Devolve também o maior volume entre todos os inteiros (nenhum preço do meio negocia mais).
 */
function bruteForce(orders: readonly AuctionOrder[], reference: number) {
  const limits = new Set(orders.map((o) => o.limitPrice));
  let maxVolumeAnyInteger = 0;
  const candidates: { price: number; volume: number; imbalance: number; distance: number }[] = [];
  if (orders.length > 0) {
    const lo = Math.min(...orders.map((o) => o.limitPrice));
    const hi = Math.max(...orders.map((o) => o.limitPrice));
    for (let p = lo; p <= hi; p++) {
      let demand = 0;
      let supply = 0;
      for (const o of orders) {
        if (o.side === "buy" && o.limitPrice >= p) demand += o.remaining;
        if (o.side === "sell" && o.limitPrice <= p) supply += o.remaining;
      }
      const volume = Math.min(demand, supply);
      maxVolumeAnyInteger = Math.max(maxVolumeAnyInteger, volume);
      if (limits.has(p)) candidates.push({ price: p, volume, imbalance: Math.abs(demand - supply), distance: Math.abs(p - reference) });
    }
  }
  candidates.sort((a, b) => b.volume - a.volume || a.imbalance - b.imbalance || a.distance - b.distance || a.price - b.price);
  const best = candidates[0];
  if (!best || best.volume === 0) return { price: null, volume: 0, maxVolumeAnyInteger };
  return { price: best.price, volume: best.volume, maxVolumeAnyInteger };
}

function checkProperties(orders: readonly AuctionOrder[], reference: number, r: AuctionResult) {
  const expected = bruteForce(orders, reference);
  expect(r.price).toBe(expected.price);
  expect(r.volume).toBe(expected.volume);
  expect(r.volume).toBe(expected.maxVolumeAnyInteger);

  const byId = new Map(orders.map((o) => [o.id, o]));
  const filled = new Map<number, number>();
  let total = 0;
  for (const f of r.fills) {
    const b = byId.get(f.buyOrderId)!;
    const s = byId.get(f.sellOrderId)!;
    expect(b.side).toBe("buy");
    expect(s.side).toBe("sell");
    expect(f.price).toBe(r.price);
    // Compra paga no máximo o limite; venda recebe no mínimo o limite.
    expect(f.price).toBeLessThanOrEqual(b.limitPrice);
    expect(f.price).toBeGreaterThanOrEqual(s.limitPrice);
    expect(f.quantity).toBeGreaterThan(0);
    expect(Number.isInteger(f.quantity)).toBe(true);
    expect(f.buyerId).toBe(b.accountId);
    expect(f.sellerId).toBe(s.accountId);
    filled.set(b.id, (filled.get(b.id) ?? 0) + f.quantity);
    filled.set(s.id, (filled.get(s.id) ?? 0) + f.quantity);
    total += f.quantity;
  }
  expect(total).toBe(r.volume);

  // A soma dos negócios de cada ordem não passa da quantidade dela, e a sobra é o resto.
  expect(r.remaining.size).toBe(orders.length);
  for (const o of orders) {
    const f = filled.get(o.id) ?? 0;
    expect(f).toBeLessThanOrEqual(o.remaining);
    expect(r.remaining.get(o.id)).toBe(o.remaining - f);
  }

  // A sobra nunca fica cruzada.
  const left = orders.filter((o) => r.remaining.get(o.id)! > 0);
  const bestBid = Math.max(-Infinity, ...left.filter((o) => o.side === "buy").map((o) => o.limitPrice));
  const bestAsk = Math.min(Infinity, ...left.filter((o) => o.side === "sell").map((o) => o.limitPrice));
  expect(bestBid).toBeLessThan(bestAsk);
}

describe("clearAuction: propriedades com ordens sorteadas (semente fixa)", () => {
  it("600 cenários batem com a força bruta, respeitam limites e quantidades e não dependem da ordem de chegada", () => {
    const rnd = mulberry32(20261109);
    let withTrade = 0;
    for (let i = 0; i < 600; i++) {
      const { orders, reference } = randomScenario(rnd);
      const r = clearAuction(orders, reference);
      checkProperties(orders, reference, r);
      if (r.price !== null) withTrade++;

      // O resultado não muda se as ordens chegarem embaralhadas.
      for (let k = 0; k < 3; k++) {
        const again = clearAuction(shuffle(rnd, orders), reference);
        expect(again.price).toBe(r.price);
        expect(again.volume).toBe(r.volume);
        expect(again.fills).toEqual(r.fills);
        expect([...again.remaining].sort((a, b) => a[0] - b[0])).toEqual([...r.remaining].sort((a, b) => a[0] - b[0]));
      }
    }
    // O sorteio tem de exercitar os dois casos.
    expect(withTrade).toBeGreaterThan(200);
    expect(withTrade).toBeLessThan(600);
  });
});
