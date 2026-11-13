import { describe, expect, it } from "vitest";
import { holdingKey, planAnnulment, planCashAnnulment, replayCost, type AnnulTrade, type ReplayEntry } from "../src/engine/annulment.js";

// Critério 42 de "Admin" e as propostas 17 e 18 do Plano do admin de jogadores e bots.

const ANA = 1;
const BRUNO = 2;
const CARLA = 3;
const T0 = Date.parse("2026-08-03T15:00:00Z");

let seq = 0;
const trade = (p: Partial<AnnulTrade> & { buyerWallet: number; sellerWallet: number; price: number }): AnnulTrade => ({
  id: ++seq,
  at: T0 + seq * 60_000,
  clubId: 1,
  quantity: 1,
  ...p,
});

const free = (entries: [number, number][], clubId = 1) =>
  new Map(entries.map(([w, n]) => [holdingKey(w, clubId), n] as const));

describe("planAnnulment", () => {
  it("admin 42: Bruno recebe de volta as 3 SPT3 e Ana os R$ 25,48", () => {
    const a = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 770 });
    const b = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 847 });
    const c = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 931 });
    const plan = planAnnulment([a, b, c], free([[ANA, 3]]));
    expect(plan.steps.map((s) => s.tradeId)).toEqual([c.id, b.id, a.id]);
    expect(plan.steps.map((s) => s.returned)).toEqual([1, 1, 1]);
    expect(plan.steps.reduce((n, s) => n + s.cash, 0)).toBe(2548);
    expect([...plan.remaining.values()]).toEqual([0, 0, 0]);
  });

  it("ida e volta entre os dois se desfaz do mais novo para o mais antigo sem faltar ação", () => {
    const ida = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 800, quantity: 5 });
    const volta = trade({ buyerWallet: BRUNO, sellerWallet: ANA, price: 900, quantity: 5 });
    // no fim, Ana não tem nada e Bruno as 5: sem o desfazer em ordem, a ida faltaria
    const plan = planAnnulment([ida, volta], free([[BRUNO, 5]]));
    expect(plan.steps.map((s) => [s.tradeId, s.returned, s.short])).toEqual([
      [volta.id, 5, 0],
      [ida.id, 5, 0],
    ]);
  });

  it("Ana comprou 3 e vendeu 2 a Carla: volta 1 ação, Ana recebe só o valor dela e Bruno fica com o resto", () => {
    const compra = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 800, quantity: 3 });
    const plan = planAnnulment([compra], free([[ANA, 1]]));
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ returned: 1, short: 2, cash: 800 });
    expect(plan.remaining.get(compra.id)).toBe(2);
  });

  it("falta total não move nada", () => {
    const compra = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 800, quantity: 3 });
    const plan = planAnnulment([compra], free([]));
    expect(plan.steps[0]).toMatchObject({ returned: 0, short: 3, cash: 0 });
  });

  it("as ações livres que sobram entram na ordem: o mais novo recebe primeiro", () => {
    const velho = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 700, quantity: 4 });
    const novo = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 900, quantity: 4 });
    const plan = planAnnulment([velho, novo], free([[ANA, 5]]));
    expect(plan.steps.map((s) => s.returned)).toEqual([4, 1]);
    expect(plan.steps.map((s) => s.cash)).toEqual([3600, 700]);
  });

  it("a soma das ações do clube não muda", () => {
    const trades = [
      trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 700, quantity: 4 }),
      trade({ buyerWallet: BRUNO, sellerWallet: ANA, price: 800, quantity: 2 }),
      trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 900, quantity: 7 }),
    ];
    const start = free([
      [ANA, 3],
      [BRUNO, 1],
      [CARLA, 9],
    ]);
    const plan = planAnnulment(trades, start);
    const after = new Map(start);
    for (const s of plan.steps) {
      after.set(holdingKey(s.buyerWallet, 1), (after.get(holdingKey(s.buyerWallet, 1)) ?? 0) - s.returned);
      after.set(holdingKey(s.sellerWallet, 1), (after.get(holdingKey(s.sellerWallet, 1)) ?? 0) + s.returned);
    }
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    expect(sum(after)).toBe(sum(start));
  });

  it("clubes diferentes não misturam as ações livres", () => {
    const a = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 700, clubId: 1 });
    const b = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 700, clubId: 2 });
    const plan = planAnnulment([a, b], free([[ANA, 1]], 1));
    expect(plan.remaining.get(a.id)).toBe(0);
    expect(plan.remaining.get(b.id)).toBe(1);
  });

  it("recusa negócio repetido, quantidade ou preço inválidos e a mesma carteira nos dois lados", () => {
    const t = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 700 });
    expect(() => planAnnulment([t, t], free([]))).toThrow();
    expect(() => planAnnulment([{ ...t, quantity: 0 }], free([]))).toThrow();
    expect(() => planAnnulment([{ ...t, price: 0 }], free([]))).toThrow();
    expect(() => planAnnulment([{ ...t, sellerWallet: ANA }], free([]))).toThrow();
  });
});

describe("planCashAnnulment (depois do fim da negociação)", () => {
  const buyback = (perShare: number, clubId = 1) => new Map([[clubId, perShare]]);

  it("admin 42: Ana comprou de Bruno 3 SPT3 a R$ 8,00 com recompra de R$ 5,00: recebe R$ 24,00 e devolve R$ 15,00", () => {
    const t = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 800, quantity: 3 });
    const plan = planCashAnnulment([t], free([[ANA, 3]]), buyback(500));
    expect(plan.steps).toEqual([
      expect.objectContaining({ tradeId: t.id, returned: 3, short: 0, cash: 2400, perShare: 500, buyback: 1500, buyerCash: 900 }),
    ]);
    // Bruno, o vendedor, faz o contrário: −R$ 9,00, e as ações não se movem
    expect(plan.remaining.get(t.id)).toBe(0);
  });

  it("a falta é pelas ações da foto: o que Ana já não tinha fica, e o dinheiro dessas ações fica com Bruno", () => {
    const t = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 800, quantity: 3 });
    const plan = planCashAnnulment([t], free([[ANA, 1]]), buyback(500));
    expect(plan.steps[0]).toMatchObject({ returned: 1, short: 2, cash: 800, buyback: 500, buyerCash: 300 });
    expect(planCashAnnulment([t], free([]), buyback(500)).steps[0]).toMatchObject({ returned: 0, buyerCash: 0 });
  });

  it("recompra acima do preço: o comprador devolve mais do que recebe", () => {
    const t = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 400, quantity: 2 });
    expect(planCashAnnulment([t], free([[ANA, 2]]), buyback(650)).steps[0]).toMatchObject({ cash: 800, buyback: 1300, buyerCash: -500 });
  });

  it("ida e volta na foto se desfaz como no planAnnulment, cada clube com a sua recompra", () => {
    const ida = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 800, quantity: 2 });
    const volta = trade({ buyerWallet: BRUNO, sellerWallet: ANA, price: 900, quantity: 2 });
    const outro = trade({ buyerWallet: ANA, sellerWallet: CARLA, price: 1000, clubId: 2 });
    const photo = new Map([...free([[BRUNO, 2]]), ...free([[ANA, 1]], 2)]);
    const plan = planCashAnnulment([ida, volta, outro], photo, new Map([[1, 500], [2, 100]]));
    expect(plan.steps.map((s) => [s.tradeId, s.returned, s.buyerCash])).toEqual([
      [outro.id, 1, 900],
      [volta.id, 2, 800],
      [ida.id, 2, 600],
    ]);
  });

  it("clube sem a recompra, ou recompra inválida, é erro de quem chama", () => {
    const t = trade({ buyerWallet: ANA, sellerWallet: BRUNO, price: 800 });
    expect(() => planCashAnnulment([t], free([[ANA, 1]]), new Map())).toThrow();
    expect(() => planCashAnnulment([t], free([[ANA, 1]]), buyback(-1))).toThrow();
    expect(() => planCashAnnulment([t], free([[ANA, 1]]), buyback(1.5))).toThrow();
  });
});

describe("replayCost", () => {
  const buyE = (quantity: number, price: number, tradeId?: number): ReplayEntry => ({ sharesDelta: quantity, price, tradeId });
  const sellE = (quantity: number, price: number, tradeId?: number): ReplayEntry => ({ sharesDelta: -quantity, price, tradeId });

  it("o preço médio de Ana, que tinha outras SPT3, volta ao de antes da compra", () => {
    const history = [buyE(10, 700), buyE(1, 770, 11), buyE(1, 847, 12), buyE(1, 931, 13)];
    const result = replayCost(
      history,
      new Map([
        [11, 0],
        [12, 0],
        [13, 0],
      ]),
    );
    expect(result).toEqual({ shares: 10, cost: 7000, realized: 0 });
  });

  it("o resultado da venda de Bruno some e o custo volta ao que era antes", () => {
    const history = [buyE(5, 600), sellE(1, 770, 11), sellE(1, 847, 12)];
    const withTrades = replayCost(history, new Map());
    expect(withTrades.realized).toBe(170 + 247);
    const without = replayCost(
      history,
      new Map([
        [11, 0],
        [12, 0],
      ]),
    );
    expect(without).toEqual({ shares: 5, cost: 3000, realized: 0 });
  });

  it("venda a Carla refaz o realizado de Ana: ela vende o que sobrou da compra desfeita pela metade", () => {
    // Ana comprou 3 a 800 de Bruno, vendeu 2 a 1000 a Carla; só 1 volta, 2 ficam
    const history = [buyE(3, 800, 11), sellE(2, 1000, 99)];
    expect(replayCost(history, new Map([[11, 2]]))).toEqual({ shares: 0, cost: 0, realized: 400 });
  });

  it("falta total mantém o negócio inteiro", () => {
    expect(replayCost([buyE(3, 800, 11)], new Map([[11, 3]]))).toEqual({ shares: 3, cost: 2400, realized: 0 });
  });

  it("débito do admin não realiza resultado", () => {
    const history: ReplayEntry[] = [buyE(4, 500), { sharesDelta: -1, debit: true }];
    expect(replayCost(history, new Map())).toEqual({ shares: 3, cost: 1500, realized: 0 });
  });

  it("falha se o histórico refeito deixa a posição negativa", () => {
    expect(() => replayCost([buyE(2, 700, 11), sellE(2, 800, 12)], new Map([[11, 0]]))).toThrow();
  });
});
