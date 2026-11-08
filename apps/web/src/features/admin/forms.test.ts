import { describe, expect, it } from "vitest";
import { suspensionNotice } from "../market/suspension-banner";
import { queryString as qs } from "./api";
import { differsFromSource, formatCents, moveInOrder, reasonFeedback } from "./forms";

describe("formulários do admin", () => {
  it("admin 33: o motivo vale com 3 a 500 caracteres e vazio não vale", () => {
    expect(reasonFeedback("").ok).toBe(false);
    expect(reasonFeedback("   ").ok).toBe(false);
    expect(reasonFeedback("ab").ok).toBe(false);
    expect(reasonFeedback("placar errado").ok).toBe(true);
    expect(reasonFeedback("x".repeat(501)).ok).toBe(false);
  });

  it("subir e descer um clube na classificação troca com o vizinho e não passa das pontas", () => {
    expect(moveInOrder([1, 2, 3], 2, -1)).toEqual([2, 1, 3]);
    expect(moveInOrder([1, 2, 3], 2, 1)).toEqual([1, 3, 2]);
    expect(moveInOrder([1, 2, 3], 1, -1)).toEqual([1, 2, 3]);
    expect(moveInOrder([1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
    expect(moveInOrder([1, 2, 3], 9, 1)).toEqual([1, 2, 3]);
  });

  it("a diferença para a fonte aponta só as linhas em outra posição", () => {
    expect(
      differsFromSource([
        { position: 1, sourcePosition: 2 },
        { position: 2, sourcePosition: 1 },
        { position: 3, sourcePosition: 3 },
        { position: 4, sourcePosition: null },
      ]),
    ).toEqual([0, 1]);
  });

  it("centavos viram reais com vírgula", () => {
    expect(formatCents(1250)).toMatch(/12,50/);
  });

  it("a query só leva o que tem valor", () => {
    expect(qs({ page: 2, action: "", actorId: undefined })).toBe("?page=2");
    expect(qs({})).toBe("");
  });
});

describe("faixa de suspensão", () => {
  it("admin 23: mostra o mercado todo e cada clube com o motivo, e some quando nada está suspenso", () => {
    const season = { id: 1, year: 2027, status: "trading" as const, offerSize: null, firstKickoff: null, ipoOpensAt: null, ipoClosesAt: null, tradingOpensAt: null };
    expect(suspensionNotice(null)).toEqual([]);
    expect(suspensionNotice({ season: { ...season, suspendedReason: null }, suspendedClubs: [] })).toEqual([]);
    expect(
      suspensionNotice({ season: { ...season, suspendedReason: "falha na fonte" }, suspendedClubs: [{ ticker: "FLA3", reason: "estádio interditado" }] }),
    ).toEqual(["Negociação suspensa em todos os clubes: falha na fonte", "Negociação de FLA3 suspensa: estádio interditado"]);
  });
});
