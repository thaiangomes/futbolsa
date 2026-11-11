import type { BookView, EventEnvelope } from "@futbolsa/contracts";
import { describe, expect, it } from "vitest";
import { applyClubEvent, changeBpOf, mergeTrades } from "./club-state";

// W1 do Plano do livro de ofertas e formador: o estado da tela do clube a partir de GET /clubs/:ticker/book e dos eventos do canal.

const level = (price: number, quantity = 10, orders = 1) => ({ price, quantity, orders });
const trade = (id: number, price: number, quantity = 1) => ({ id, at: `2027-04-05T13:${String(id).padStart(2, "0")}:00.000Z`, price, quantity });

const view = (over: Partial<BookView> = {}): BookView => ({
  ticker: "FLA3",
  seq: 10,
  price: { displayed: 4300, open: 4000, changeBp: 750 },
  matchMode: false,
  auction: null,
  market: { state: "open", opensAt: "2027-04-05T13:00:00.000Z", reason: null },
  bids: [level(4200)],
  asks: [level(4410)],
  trades: [trade(2, 4300), trade(1, 4200)],
  me: null,
  ...over,
});

const event = (type: string, data: unknown, seq = 11): EventEnvelope => ({ type, channel: "club:FLA3", seq, at: "2027-04-05T13:10:00.000Z", data }) as EventEnvelope;

describe("changeBpOf", () => {
  it("livro 20: de R$ 40,00 para R$ 42,00 são +5,00% (500)", () => {
    expect(changeBpOf(4200, 4000)).toBe(500);
    expect(changeBpOf(3800, 4000)).toBe(-500);
    expect(changeBpOf(3001, 3000)).toBe(3);
  });
});

describe("mergeTrades", () => {
  it("negócio repetido não aparece duas vezes, e a lista fica do mais novo para o mais antigo, com no máximo 20", () => {
    const base = [trade(3, 100), trade(2, 100)];
    expect(mergeTrades(base, [trade(3, 100)]).map((t) => t.id)).toEqual([3, 2]);
    expect(mergeTrades(base, [trade(4, 100)]).map((t) => t.id)).toEqual([4, 3, 2]);
    // chegando fora de ordem
    expect(mergeTrades(base, [trade(5, 100), trade(4, 100)]).map((t) => t.id)).toEqual([5, 4, 3, 2]);
    const many = Array.from({ length: 25 }, (_, i) => trade(i + 1, 100));
    expect(mergeTrades([], many)).toHaveLength(20);
    expect(mergeTrades([], many)[0]!.id).toBe(25);
  });
});

describe("applyClubEvent", () => {
  it("trade: entra na lista, vira o preço exibido e a variação é refeita contra o preço das 0h", () => {
    const next = applyClubEvent(view(), event("trade", trade(3, 4400, 7)));
    expect(next.trades.map((t) => t.id)).toEqual([3, 2, 1]);
    expect(next.price).toEqual({ displayed: 4400, open: 4000, changeBp: 1000 });
  });

  it("trade repetido é aplicado de novo sem mudar nada (seguro de repetir)", () => {
    const once = applyClubEvent(view(), event("trade", trade(3, 4400)));
    expect(applyClubEvent(once, event("trade", trade(3, 4400)))).toEqual(once);
  });

  it("trade mais velho que um já mostrado não volta o preço atrás", () => {
    const next = applyClubEvent(view({ trades: [trade(9, 4300)] }), event("trade", trade(5, 3900)));
    expect(next.price.displayed).toBe(4300);
    expect(next.trades.map((t) => t.id)).toEqual([9, 5]);
  });

  it("book: troca os dois lados e o estado do leilão pelo valor absoluto", () => {
    const next = applyClubEvent(view(), event("book", { bids: [level(4250, 5, 2)], asks: [], auction: { until: "2027-04-05T18:40:00.000Z" } }));
    expect(next.bids).toEqual([level(4250, 5, 2)]);
    expect(next.asks).toEqual([]);
    expect(next.auction).toEqual({ until: "2027-04-05T18:40:00.000Z" });
    // livro 45: leilão parado pela suspensão chega com `until` vazio
    expect(applyClubEvent(next, event("book", { bids: [], asks: [], auction: { until: null } })).auction).toEqual({ until: null });
    expect(applyClubEvent(next, event("book", { bids: [], asks: [], auction: null })).auction).toBeNull();
  });

  it("match_mode liga e desliga o aviso \"em jogo agora\"", () => {
    expect(applyClubEvent(view(), event("match_mode", { active: true })).matchMode).toBe(true);
    expect(applyClubEvent(view({ matchMode: true }), event("match_mode", { active: false })).matchMode).toBe(false);
  });

  it("evento de outro tipo, ou com dado fora do esquema, não muda o estado", () => {
    const state = view();
    expect(applyClubEvent(state, event("candle", { interval: "15m" }))).toBe(state);
    expect(applyClubEvent(state, event("book", { bids: "x" }))).toBe(state);
    expect(applyClubEvent(state, event("trade", { id: "x" }))).toBe(state);
  });

  it("não deixa nenhum campo de dono entrar pelo evento (esquema estrito)", () => {
    const state = view();
    expect(applyClubEvent(state, event("trade", { ...trade(3, 4400), buyerWalletId: 4 }))).toBe(state);
  });
});
