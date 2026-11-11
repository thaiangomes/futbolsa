import { describe, expect, it } from "vitest";
import { changesOf, formatPercent, formErrors, formOf, parseMinimum, parsePercent } from "./form";

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
