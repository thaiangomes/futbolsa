import { describe, expect, it } from "vitest";
import { COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA, type CupRules } from "../src/engine/dividends.js";
import { validateCupTable } from "../src/engine/cupTable.js";

const codes = (rules: CupRules) => validateCupTable(rules).map((v) => v.code);

describe("validateCupTable: cada copa é validada sozinha", () => {
  it("dividendos 28: a tabela de 2025 de cada uma das três copas passa sem violação", () => {
    expect(validateCupTable(COPA_DO_BRASIL)).toEqual([]);
    expect(validateCupTable(LIBERTADORES)).toEqual([]);
    expect(validateCupTable(SULAMERICANA)).toEqual([]);
  });

  it("dividendos 28: a Copa do Brasil de 2026, com nove fases, passa quando as regras valem", () => {
    const cb2026: CupRules = {
      phases: ["fase-1", "fase-2", "fase-3", "fase-4", "fase-5", "oitavas", "quartas", "semifinal", "final"],
      advance: { "fase-1": 25, "fase-2": 50, "fase-3": 75, "fase-4": 100, "fase-5": 150, oitavas: 225, quartas: 375, semifinal: 600 },
      title: 1200,
    };
    expect(validateCupTable(cb2026)).toEqual([]);
  });

  it("valores sem relação com as outras copas passam (a Libertadores ×3 não precisa ser 1,5× a Copa do Brasil)", () => {
    const triplo: CupRules = {
      ...LIBERTADORES,
      advance: Object.fromEntries(Object.entries(LIBERTADORES.advance).map(([k, v]) => [k, v * 3])),
      title: LIBERTADORES.title * 3,
    };
    expect(validateCupTable(triplo)).toEqual([]);
  });

  it("recusa o valor que não cresce a cada fase (igual ou menor que o da anterior)", () => {
    expect(codes({ ...COPA_DO_BRASIL, advance: { ...COPA_DO_BRASIL.advance, quartas: 150 } })).toContain("not_increasing");
    expect(codes({ ...COPA_DO_BRASIL, advance: { ...COPA_DO_BRASIL.advance, quartas: 100 } })).toContain("not_increasing");
  });

  it("recusa título que não vale o dobro da semifinal", () => {
    expect(codes({ ...COPA_DO_BRASIL, title: 700 })).toEqual(["title_not_double_semifinal"]);
  });

  it("recusa fase preliminar que paga", () => {
    const comPreliminar: CupRules = {
      ...LIBERTADORES,
      phases: ["pre-1", ...LIBERTADORES.phases],
      advance: { "pre-1": 50, ...LIBERTADORES.advance },
    };
    expect(codes(comPreliminar)).toContain("preliminary_pays");
    // Preliminar listada sem valor continua valendo.
    expect(validateCupTable({ ...LIBERTADORES, phases: ["pre-1", ...LIBERTADORES.phases] })).toEqual([]);
  });

  it("Sul-Americana: o playoff abaixo dos grupos é válido porque o crescimento é medido pelo caminho principal", () => {
    // grupos 0,60 > playoffs 0,30 não é violação: playoffs é fase lateral do 2º do grupo.
    expect(SULAMERICANA.advance.playoffs).toBeLessThan(SULAMERICANA.advance.grupos!);
    expect(validateCupTable(SULAMERICANA)).toEqual([]);
  });

  it("Sul-Americana: os dois caminhos às oitavas têm de somar o mesmo valor (0,30 + 0,30 = 0,60)", () => {
    const desigual: CupRules = { ...SULAMERICANA, advanceTo: { grupos: { playoffs: 20 } } };
    expect(codes(desigual)).toEqual(["paths_differ"]);
    const playoffsMaior: CupRules = { ...SULAMERICANA, advance: { ...SULAMERICANA.advance, playoffs: 40 } };
    expect(codes(playoffsMaior)).toEqual(["paths_differ"]);
  });

  it("recusa chave de valor que não é fase da copa, título ausente e valores que não são centavos inteiros", () => {
    expect(codes({ ...COPA_DO_BRASIL, advance: { ...COPA_DO_BRASIL.advance, "repescagem": 10 } })).toContain("unknown_phase");
    expect(codes({ ...COPA_DO_BRASIL, title: 0 })).toContain("missing_title");
    expect(codes({ ...COPA_DO_BRASIL, advance: { ...COPA_DO_BRASIL.advance, oitavas: 150.5 } })).toContain("invalid_value");
    expect(codes({ ...COPA_DO_BRASIL, advance: { ...COPA_DO_BRASIL.advance, oitavas: -1 } })).toContain("invalid_value");
  });

  it("junta todas as violações, cada uma com mensagem em português", () => {
    const ruim: CupRules = { ...COPA_DO_BRASIL, title: 500, advance: { ...COPA_DO_BRASIL.advance, quartas: 100 } };
    const violacoes = validateCupTable(ruim);
    expect(violacoes.map((v) => v.code).sort()).toEqual(["not_increasing", "title_not_double_semifinal"]);
    expect(violacoes.every((v) => v.message.length > 10)).toBe(true);
  });

  it("copa sem semifinal na lista de fases não exige o dobro", () => {
    const curta: CupRules = { phases: ["grupos", "final"], advance: { grupos: 100 }, title: 250 };
    expect(validateCupTable(curta)).toEqual([]);
  });

  it("a fase de semifinal sem valor, quando existe, é violação", () => {
    const semValor: CupRules = { ...COPA_DO_BRASIL, advance: { ...COPA_DO_BRASIL.advance, semifinal: 0 } };
    expect(codes(semValor)).toContain("title_not_double_semifinal");
  });
});
