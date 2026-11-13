import { describe, expect, it } from "vitest";
import { ADMIN_ERROR_MESSAGES, historyResponseSchema, seasonCloseBodySchema, seasonClosePreviewSchema } from "@futbolsa/contracts";

describe("contratos do encerramento (F15, T1)", () => {
  it("admin 21: a prévia aceita a lista do que falta, com um código por item", () => {
    const preview = {
      seasonId: 1,
      year: 2027,
      status: "trading_ended",
      blockers: [{ code: "payouts_pending", count: 2, text: "2 pagamentos aguardam aprovação", link: "/admin/pagamentos" }],
      canClose: false,
      summary: { wallets: 3, totalCash: 30_000_000, leader: { nickname: "ana", equity: 16_340_000 } },
    };
    expect(seasonClosePreviewSchema.parse(preview)).toEqual(preview);
    expect(() => seasonClosePreviewSchema.parse({ ...preview, blockers: [{ ...preview.blockers[0], code: "outro" }] })).toThrow();
  });
  it("admin 38: o corpo do POST leva o ano e nada mais", () => {
    expect(seasonCloseBodySchema.parse({ confirmYear: 2027 })).toEqual({ confirmYear: 2027 });
    expect(() => seasonCloseBodySchema.parse({ confirmYear: "2027" })).toThrow();
    expect(() => seasonCloseBodySchema.parse({ confirmYear: 2027, x: 1 })).toThrow();
  });
  it("conta 15: o histórico traz ano, patrimônio, base, posição e posições mensais", () => {
    const body = { seasons: [{ year: 2027, finalEquity: 16_340_000, base: 10_000_000, position: 2, months: [{ month: "2027-12", position: 1 }] }] };
    expect(historyResponseSchema.parse(body)).toEqual(body);
  });
  it("os códigos novos têm mensagem", () => {
    for (const c of ["season_close_blocked", "confirm_year_mismatch", "season_trading_ended", "season_closed"] as const) {
      expect(ADMIN_ERROR_MESSAGES[c].length).toBeGreaterThan(5);
    }
  });
});
