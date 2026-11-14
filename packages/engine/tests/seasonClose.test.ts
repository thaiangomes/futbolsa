import { describe, expect, it } from "vitest";
import { closeBlockers, type CloseState } from "../src/index.js";

const ok: CloseState = {
  tradingEnded: true,
  matchesUnscored: 0,
  payoutsPending: 0,
  payoutsSettling: 0,
  correctionEvents: 0,
  buybackPending: 0,
  openOrders: 0,
  walletsWithShares: 0,
  recalcPending: false,
  fraudOpen: 0,
};
const codes = (s: Partial<CloseState>) => closeBlockers({ ...ok, ...s }).map((b) => b.code);

describe("closeBlockers (Admin 21)", () => {
  it("admin 21: tudo certo devolve lista vazia", () => expect(closeBlockers(ok)).toEqual([]));
  it("admin 21: jogo da última rodada sem placar impede o encerramento", () =>
    expect(closeBlockers({ ...ok, matchesUnscored: 2 })).toEqual([{ code: "matches_unscored", count: 2 }]));
  it("admin 21: pagamento aguardando aprovação impede o encerramento", () => expect(codes({ payoutsPending: 1 })).toEqual(["payouts_pending"]));
  it("recompra não fechada impede", () => expect(codes({ tradingEnded: false })).toEqual(["buyback_not_closed"]));
  it("recompra de um clube não aprovada impede", () => expect(codes({ buybackPending: 1 })).toEqual(["buyback_not_approved"]));
  it("evento aprovado ainda liquidando impede", () => expect(codes({ payoutsSettling: 3 })).toEqual(["payouts_settling"]));
  it("correção a aplicar impede", () => expect(codes({ correctionEvents: 1 })).toEqual(["corrections_pending"]));
  it("ordem aberta impede", () => expect(codes({ openOrders: 4 })).toEqual(["open_orders"]));
  it("ação que sobrou em alguma conta impede", () => expect(codes({ walletsWithShares: 1 })).toEqual(["shares_remaining"]));
  it("pedido de recálculo de ranking aberto impede", () => expect(codes({ recalcPending: true })).toEqual(["recalc_pending"]));
  it("caso de trapaça aberto impede (acréscimo de 2026-11-07)", () => expect(codes({ fraudOpen: 2 })).toEqual(["fraud_open"]));
  it("vários motivos ao mesmo tempo aparecem todos", () =>
    expect(codes({ matchesUnscored: 1, payoutsPending: 1, fraudOpen: 1, recalcPending: true })).toEqual([
      "matches_unscored",
      "payouts_pending",
      "recalc_pending",
      "fraud_open",
    ]));
});
