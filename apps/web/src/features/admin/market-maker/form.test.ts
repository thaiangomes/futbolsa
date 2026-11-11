import { describe, expect, it } from "vitest";
import { quoteSize } from "@futbolsa/engine";
import { changesOf, describeSide, formatPercent, formErrors, formOf, parseMinimum, parsePercent, quoteNote, sideQuantity } from "./form";

const state = { mmQuantityBp: 25, mmMatchQuantityBp: 6, mmMinSideQty: 10, mmMatchMinSideQty: 3, mmLotBp: 2000 };

describe("formador: números da tela (livro 34)", () => {
  it("percentual vira pontos-base, com vírgula ou ponto e até duas casas", () => {
    expect(parsePercent("0,25")).toBe(25);
    expect(parsePercent("0.06")).toBe(6);
    expect(parsePercent("1")).toBe(100);
    expect(parsePercent(" 1,5 ")).toBe(150);
    for (const bad of ["", "0", "0,00", "0,255", "-1", "abc", "100,01", "1,", "1e2"]) expect(parsePercent(bad), bad).toBeNull();
  });
  it("pontos-base voltam em texto de percentual", () => {
    expect([25, 6, 100, 150, 5, 10_000].map(formatPercent)).toEqual(["0,25", "0,06", "1", "1,5", "0,05", "100"]);
  });
  it("mínimo é inteiro de 1 em diante", () => {
    expect(parseMinimum("10")).toBe(10);
    for (const bad of ["", "0", "1,5", "-2", "x"]) expect(parseMinimum(bad), bad).toBeNull();
  });
  it("o formulário parte dos valores em vigor", () => {
    expect(formOf(state)).toEqual({ quantity: "0,25", matchQuantity: "0,06", minSide: "10", matchMinSide: "3" });
  });
  it("mensagem e campos inválidos como na prancha", () => {
    const base = formOf(state);
    expect(formErrors(base)).toEqual({ invalid: new Set(), message: null });
    expect(formErrors({ ...base, quantity: "0" })).toMatchObject({ message: expect.stringContaining("maior que zero") });
    expect([...formErrors({ ...base, matchMinSide: "0" }).invalid]).toEqual(["matchMinSide"]);
    expect(formErrors({ ...base, minSide: "x" }).message).toContain("inteiro");
  });
  it("só envia o que mudou; sem mudança ou com campo inválido não envia nada", () => {
    const base = formOf(state);
    expect(changesOf(state, base)).toBeNull();
    expect(changesOf(state, { ...base, quantity: "0,30", matchMinSide: "4" })).toEqual({ mmQuantityBp: 30, mmMatchMinSideQty: 4 });
    expect(changesOf(state, { ...base, quantity: "0,25", matchQuantity: "0,060" })).toBeNull();
    expect(changesOf(state, { ...base, minSide: "0" })).toBeNull();
  });
});

describe("formador: prévia e quadro da tesouraria", () => {
  it("a quantidade por lado é a do motor (quoteSize) em vários tamanhos de clube", () => {
    for (const total of [0, 1, 100, 3000, 3736, 100_000]) {
      for (const [bp, min] of [[25, 10], [6, 3], [100, 1], [10_000, 5]] as const) {
        expect(sideQuantity(total, bp, min).quantity, `${total} ${bp} ${min}`).toBe(quoteSize(total, bp, min));
      }
    }
  });
  it("o texto da prévia diz quando vale o mínimo", () => {
    expect(describeSide(3736, 25, 10)).toBe("10 por lado (0,25% dá 9; vale o mínimo)");
    expect(describeSide(3736, 6, 3)).toBe("3 por lado (0,06% dá 2; vale o mínimo)");
    expect(describeSide(3736, 100, 10)).toBe("37 por lado");
  });
  it("a coluna 'A casa cota' segue a situação, as ações livres e o caixa", () => {
    const c = (freeShares: number, status: "trading" | "in_match" | "auction" | "suspended") => ({ ticker: "PAL3", freeShares, status });
    expect(quoteNote(c(10, "trading"), 100)).toBe("Compra e venda");
    expect(quoteNote(c(0, "trading"), 100)).toBe("Só compra: a tesouraria está sem ações livres do PAL3");
    expect(quoteNote(c(10, "trading"), 0)).toBe("Só vende: a tesouraria está sem caixa livre");
    expect(quoteNote(c(0, "trading"), 0)).toContain("Nada");
    expect(quoteNote(c(10, "suspended"), 100)).toBe("Nada: a casa não cota clube suspenso");
    expect(quoteNote(c(10, "in_match"), 100)).toBe("Compra e venda, com a quantidade do modo de jogo");
    expect(quoteNote(c(10, "auction"), 100)).toContain("preço único do leilão");
  });
});
