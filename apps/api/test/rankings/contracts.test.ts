import { describe, expect, it } from "vitest";
import { liveQuerySchema, rankingRowSchema, rankingsLiveEventSchema, rankingPageQuerySchema, officialRankingSchema, EVENT_CATALOG } from "@futbolsa/contracts";

const row = { position: 1, walletKey: "k1", displayName: "Ana", isBot: false, botLabel: null, returnBp: 800 };

describe("contratos dos rankings (T1)", () => {
  it("recusa retorno não inteiro, posição menor que 1 e campo com patrimônio", () => {
    expect(rankingRowSchema.safeParse({ ...row, returnBp: 8.5 }).success).toBe(false);
    expect(rankingRowSchema.safeParse({ ...row, position: 0 }).success).toBe(false);
    expect(rankingRowSchema.safeParse({ ...row, equity: 1 }).success).toBe(false);
    expect(rankingRowSchema.safeParse({ ...row, base: 1 }).success).toBe(false);
  });
  it("aceita conta excluída (nome nulo, não bot) e sem base (retorno nulo)", () => {
    expect(rankingRowSchema.safeParse({ ...row, displayName: null, returnBp: null }).success).toBe(true);
  });
  it("limite acima de 100 recusado", () => {
    expect(rankingPageQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(liveQuerySchema.parse({}).period).toBe("month");
  });
  it("o evento rankings.live leva no máximo o topo 20 e está no catálogo do canal rankings", () => {
    expect(EVENT_CATALOG["rankings.live"]).toBe("rankings");
    const base = { period: "month", periodKey: "2027-06", computedAt: "2027-06-01T00:00:00.000Z", total: 30 };
    expect(rankingsLiveEventSchema.safeParse({ ...base, top: Array.from({ length: 20 }, (_, i) => ({ ...row, position: i + 1 })) }).success).toBe(true);
    expect(rankingsLiveEventSchema.safeParse({ ...base, top: Array.from({ length: 21 }, (_, i) => ({ ...row, position: i + 1 })) }).success).toBe(false);
  });
  it("o ranking oficial não tem campo de patrimônio", () => {
    const o = { period: "month", periodKey: "2027-06", closedAt: "x", version: 1, botsIncluded: false, total: 1, offset: 0, rows: [row] };
    expect(officialRankingSchema.safeParse(o).success).toBe(true);
    expect(officialRankingSchema.safeParse({ ...o, equity: 1 }).success).toBe(false);
  });
});
