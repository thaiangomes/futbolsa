import { describe, expect, it } from "vitest";
import {
  adjustBodySchema,
  auditQuerySchema,
  blockBodySchema,
  deletePlayerBodySchema,
  patchBotsBodySchema,
  patchSeasonBodySchema,
} from "@futbolsa/contracts";
import { ADMIN_ACTIONS, reasonRequired } from "../../src/modules/admin/log/reasons.js";

describe("F14, T1: contratos do admin de jogadores e bots", () => {
  it("admin 28: o ajuste recusa delta zero, não inteiro, ticker fora do formato e ações sem clube", () => {
    const ok = { asset: "cash", delta: 100, reason: "correção combinada" };
    expect(adjustBodySchema.safeParse(ok).success).toBe(true);
    expect(adjustBodySchema.safeParse({ ...ok, delta: 0 }).success).toBe(false);
    expect(adjustBodySchema.safeParse({ ...ok, delta: 1.5 }).success).toBe(false);
    expect(adjustBodySchema.safeParse({ asset: "shares", delta: 3, reason: "ajuste" }).success).toBe(false);
    expect(adjustBodySchema.safeParse({ asset: "shares", ticker: "fla3", delta: 3, reason: "ajuste" }).success).toBe(false);
    expect(adjustBodySchema.safeParse({ asset: "shares", ticker: "FLA3", delta: -3, reason: "ajuste" }).success).toBe(true);
    expect(adjustBodySchema.safeParse({ asset: "cash", ticker: "FLA3", delta: 3, reason: "ajuste" }).success).toBe(false);
  });

  it("admin 33: motivo vazio ou longo demais é recusado nas ações de jogador", () => {
    expect(blockBodySchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(blockBodySchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
    expect(deletePlayerBodySchema.safeParse({ confirmNickname: "Ana", reason: "" }).success).toBe(false);
    expect(deletePlayerBodySchema.safeParse({ confirmNickname: "Ana", reason: "pedido do titular" }).success).toBe(true);
    for (const action of ["player.block", "player.unblock", "player.delete", "player.adjust"] as const) {
      expect(reasonRequired(action), action).toBe(true);
    }
    expect(Object.keys(ADMIN_ACTIONS)).toContain("bots.update");
  });

  it("admin 29: a contagem dos bots vai de 0 a 200, em perfis conhecidos", () => {
    expect(patchBotsBodySchema.safeParse({ counts: { momentum: 10 } }).success).toBe(true);
    expect(patchBotsBodySchema.safeParse({ counts: { momentum: -1 } }).success).toBe(false);
    expect(patchBotsBodySchema.safeParse({ counts: { momentum: 201 } }).success).toBe(false);
    expect(patchBotsBodySchema.safeParse({ counts: { fofoqueiro: 1 } }).success).toBe(false);
    expect(patchBotsBodySchema.safeParse({ counts: {} }).success).toBe(false);
  });

  it("admin 35: a temporada aceita só botsInRankings; a auditoria pede dois ids no par", () => {
    expect(patchSeasonBodySchema.safeParse({ botsInRankings: true }).success).toBe(true);
    expect(patchSeasonBodySchema.safeParse({}).success).toBe(false);
    expect(auditQuerySchema.safeParse({ pair: "a,b" }).success).toBe(true);
    expect(auditQuerySchema.safeParse({ pair: "a" }).success).toBe(false);
  });
});
