import { describe, expect, it } from "vitest";
import { buybackPerShare } from "../src/engine/buyback.js";
import { CHAMPION, ClubBetError, buybackIfEndedNow, clubValue, cupMissing, type ClubBet, type ClubValueInput } from "../src/engine/clubValue.js";
import { BRASILEIRAO_A, BRASILEIRAO_B, COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA } from "../src/engine/dividends.js";
import { reais } from "../src/engine/money.js";
import type { SeasonValues } from "../src/engine/seasonValues.js";

const values: SeasonValues = {
  leagues: { "brasileirao-a": BRASILEIRAO_A, "brasileirao-b": BRASILEIRAO_B },
  cups: { "copa-do-brasil": COPA_DO_BRASIL, libertadores: LIBERTADORES, sulamericana: SULAMERICANA },
};

/** O FLA3 do critério 38: R$ 2,70 pagos, R$ 0,30 a receber, 20 pontos, nas oitavas da Copa do Brasil e nos grupos da Libertadores, preço R$ 44,30. */
const fla3: ClubValueInput = {
  values,
  league: "brasileirao-a",
  leagueOpen: true,
  paid: reais(2.7),
  toReceive: reais(0.3),
  points: 20,
  buybackMultipleBp: 15_000,
  displayedPrice: reais(44.3),
  cups: [
    { competition: "copa-do-brasil", currentPhase: "oitavas" },
    { competition: "libertadores", currentPhase: "grupos" },
  ],
};

const aposta68: ClubBet = { points: 68, position: 3, cups: { "copa-do-brasil": "quartas", libertadores: "quartas" } };

function erroDa(input: ClubValueInput, bet: ClubBet): ClubBetError {
  try {
    clubValue(input, bet);
  } catch (e) {
    return e as ClubBetError;
  }
  throw new Error("a aposta não foi recusada");
}

describe("clubValue: o simulador \"Quanto vale para você\"", () => {
  it("livro 38: com R$ 2,70 pagos, R$ 0,30 a receber e 20 pontos, a recompra se acabasse agora é R$ 4,50", () => {
    expect(clubValue(fla3).buybackNow).toBe(reais(4.5));
    expect(clubValue(fla3).simulation).toBeNull();
    expect(buybackIfEndedNow(reais(2.7), reais(0.3), 15_000)).toBe(450);
  });

  it("livro 38: simulando 68 pontos, 3º lugar, queda nas quartas da Copa do Brasil e da Libertadores, faltam R$ 14,35 e o valor é R$ 39,93", () => {
    const s = clubValue(fla3, aposta68).simulation!;
    expect(s.missing.points).toBe(reais(4.8));
    expect(s.missing.placement).toBe(reais(4));
    expect(s.missing.cups).toEqual({ "copa-do-brasil": reais(1.5), libertadores: reais(3.75) });
    expect(s.missing.toReceive).toBe(reais(0.3));
    expect(s.missing.total).toBe(reais(14.35));
    expect(s.seasonTotal).toBe(reais(17.05));
    expect(s.buyback).toBe(reais(25.58)); // 1,5 × R$ 17,05 = 25,575, meio centavo para cima
    expect(s.value).toBe(reais(39.93));
    expect(s.outlook).toEqual({ kind: "downside", percent: 10 }); // o preço de R$ 44,30 está acima de R$ 39,93: 1 − 39,93 ÷ 44,30 = 9,86%
  });

  it("a recompra simulada é a mesma conta do buybackPerShare (meio centavo para cima)", () => {
    const s = clubValue(fla3, { points: 68, position: 3, cups: {} }).simulation!;
    expect(s.buyback).toBe(buybackPerShare(s.seasonTotal, 15_000));
    expect(buybackPerShare(1705, 15_000)).toBe(2558);
  });

  it("sem apostar nas copas, o clube cai já na fase em que está e as copas não somam", () => {
    const s = clubValue(fla3, { points: 20, position: 17, cups: {} }).simulation!;
    expect(s.missing.cups).toEqual({ "copa-do-brasil": 0, libertadores: 0 });
    expect(s.missing.placement).toBe(0); // 17º ao 20º não pagam
    expect(s.missing.total).toBe(reais(0.3));
    expect(s.value).toBe(reais(0.3) + buybackPerShare(reais(3), 15_000));
  });

  it("campeão da Libertadores soma as fases e o título", () => {
    const s = clubValue(fla3, { points: 20, position: 1, cups: { libertadores: CHAMPION } }).simulation!;
    // grupos 1,50 + oitavas 2,25 + quartas 3,75 + semifinal 6,00 + título 12,00
    expect(s.missing.cups.libertadores).toBe(reais(1.5 + 2.25 + 3.75 + 6 + 12));
    expect(s.missing.placement).toBe(reais(5));
  });

  it("cair na final paga as fases até a semifinal e não o título", () => {
    expect(cupMissing(LIBERTADORES, "grupos", "final")).toBe(reais(1.5 + 2.25 + 3.75 + 6));
  });

  it("cair na fase em que está não paga nada", () => {
    expect(cupMissing(COPA_DO_BRASIL, "oitavas", "oitavas")).toBe(0);
  });

  it("clube que já caiu da copa não ganha mais nada dela e não pode apostar nela", () => {
    const caiu: ClubValueInput = {
      ...fla3,
      cups: [
        { competition: "copa-do-brasil", currentPhase: null },
        { competition: "libertadores", currentPhase: "grupos" },
      ],
    };
    const s = clubValue(caiu, { points: 20, position: 17, cups: {} }).simulation!;
    expect(s.missing.cups).toEqual({ libertadores: 0 });
    expect(erroDa(caiu, { points: 20, position: 1, cups: { "copa-do-brasil": "semifinal" } }).message).toMatch(/já caiu/);
  });

  describe("aposta incoerente é recusada com o motivo", () => {
    it("pontos abaixo dos atuais", () => {
      const e = erroDa(fla3, { points: 19, position: 3, cups: {} });
      expect(e).toBeInstanceOf(ClubBetError);
      expect(e.code).toBe("points_below_current");
      expect(e.message).toContain("20 pontos");
    });
    it("pontos e colocação que não são inteiros válidos", () => {
      expect(erroDa(fla3, { points: 20.5, position: 3, cups: {} }).code).toBe("invalid_points");
      expect(erroDa(fla3, { points: 30, position: 0, cups: {} }).code).toBe("invalid_position");
    });
    it("fase anterior à atual", () => {
      expect(erroDa(fla3, { points: 30, position: 3, cups: { "copa-do-brasil": "3a-fase" } }).code).toBe("phase_before_current");
    });
    it("fase que a copa não tem e copa que o clube não disputa", () => {
      expect(erroDa(fla3, { points: 30, position: 3, cups: { libertadores: "playoffs" } }).code).toBe("unknown_phase");
      expect(erroDa(fla3, { points: 30, position: 3, cups: { sulamericana: "quartas" } }).code).toBe("unknown_cup");
    });
  });

  it("campeonato já fechado: pontos e colocação já foram pagos e a aposta neles não soma", () => {
    const fechado: ClubValueInput = { ...fla3, leagueOpen: false, points: 79 };
    const s = clubValue(fechado, { points: 0, position: 1, cups: { libertadores: "quartas" } }).simulation!;
    expect(s.missing.points).toBe(0);
    expect(s.missing.placement).toBe(0);
    expect(s.missing.cups.libertadores).toBe(reais(3.75));
  });

  it("Série B: R$ 0,05 por ponto e o bônus de acesso só entre os 4 primeiros", () => {
    const b: ClubValueInput = { ...fla3, league: "brasileirao-b", cups: [], points: 30 };
    expect(clubValue(b, { points: 70, position: 4, cups: {} }).simulation!.missing).toMatchObject({ points: reais(2), placement: reais(2) });
    expect(clubValue(b, { points: 70, position: 5, cups: {} }).simulation!.missing.placement).toBe(0);
  });

  it("valor zero: sem distância do preço (não divide por zero)", () => {
    const nada: ClubValueInput = { ...fla3, paid: 0, toReceive: 0, cups: [] };
    expect(clubValue(nada, { points: 20, position: 20, cups: {} }).simulation!.outlook).toBeNull();
  });

  it("preço abaixo do valor é upside (valor ÷ preço − 1); acima, downside (1 − valor ÷ preço); igual, igual", () => {
    const valor = clubValue(fla3, aposta68).simulation!.value; // R$ 39,93
    const com = (displayedPrice: number) => clubValue({ ...fla3, displayedPrice }, aposta68).simulation!.outlook;
    expect(com(valor)).toEqual({ kind: "even", percent: 0 });
    expect(com(valor - 1)).toMatchObject({ kind: "upside" });
    expect(com(valor + 1)).toMatchObject({ kind: "downside" });
    // exemplos do vault: preço muito abaixo dá upside grande; o downside nunca passa de 100%
    expect(clubValue({ ...fla3, displayedPrice: 1000 }, aposta68).simulation!.outlook).toEqual({ kind: "upside", percent: 299 }); // 39,93 ÷ 10 − 1 = 299,3%
    expect(clubValue({ ...fla3, displayedPrice: 100_000 }, aposta68).simulation!.outlook).toEqual({ kind: "downside", percent: 96 }); // 1 − 39,93 ÷ 1000 = 96,0%
  });

  it("preço abaixo do valor dá upside de 33%", () => {
    const barato: ClubValueInput = { ...fla3, displayedPrice: reais(30) };
    expect(clubValue(barato, aposta68).simulation!.outlook).toEqual({ kind: "upside", percent: 33 }); // 39,93 ÷ 30 − 1 = 33,1%
  });

  describe("copa com dois caminhos (Sul-Americana)", () => {
    it("quem está nos grupos e cai nos playoffs recebe R$ 0,30 do caminho do 2º do grupo", () => {
      expect(cupMissing(SULAMERICANA, "grupos", "playoffs")).toBe(reais(0.3));
    });
    it("quem passa por cima dos playoffs recebe o mesmo R$ 0,60 de chegar às oitavas", () => {
      expect(cupMissing(SULAMERICANA, "grupos", "oitavas")).toBe(reais(0.6));
      expect(cupMissing(SULAMERICANA, "grupos", "quartas")).toBe(reais(0.6 + 0.9));
      expect(cupMissing(SULAMERICANA, "grupos", CHAMPION)).toBe(reais(0.6 + 0.9 + 1.5 + 2.4 + 4.8));
    });
    it("quem já está nos playoffs recebe R$ 0,30 ao passar e segue pelo caminho principal", () => {
      expect(cupMissing(SULAMERICANA, "playoffs", "oitavas")).toBe(reais(0.3));
      expect(cupMissing(SULAMERICANA, "playoffs", "quartas")).toBe(reais(0.3 + 0.9));
    });
  });
});
