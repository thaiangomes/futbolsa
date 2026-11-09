import { describe, expect, it } from "vitest";
import { COPA_DO_BRASIL, type CupRules, LIBERTADORES, type SeasonValues } from "@futbolsa/engine";
import { type ListedClub, cupsExpectedAt } from "../../src/modules/ipo/bands.js";
import type { MatchRow } from "../../src/modules/admin/results/to-engine.js";

/**
 * As copas esperadas do IPO vêm da tabela de cada copa configurada para a temporada (as fases que pagam e o
 * valor de cada uma, que o admin pode mudar a cada ano), nunca de valores fixos do código (IPO por
 * bookbuilding, "Copas esperadas"; Dividendos e recompra).
 */

const FLA: ListedClub = { clubId: 1, ticker: "FLA3", division: "A", prevPlacement: 3 };
const CLOSES_AT = Date.parse("2027-04-04T19:00:00Z");

let nextId = 0;
const game = (competition: string, phase: string, home: number, away: number, kickoff: string, extra: Partial<MatchRow> = {}): MatchRow => ({
  id: ++nextId,
  seasonId: 1,
  competition,
  round: null,
  phase,
  homeClubId: home,
  awayClubId: away,
  kickoff: new Date(kickoff),
  finishedAt: null,
  homeGoals: null,
  awayGoals: null,
  advancedClubId: null,
  status: "scheduled",
  outOfWindow: false,
  source: null,
  sourceId: null,
  manualOverride: false,
  sourceSnapshot: null,
  updatedAt: new Date("2027-03-01T00:00:00Z"),
  ...extra,
});

/** Libertadores desde os grupos e Copa do Brasil na 3ª fase na data do fechamento, como no critério 5. */
const matches: MatchRow[] = [
  game("libertadores", "grupos", 1, 90, "2027-04-08T00:30:00Z"),
  game("libertadores", "grupos", 91, 1, "2027-04-22T00:30:00Z"),
  game("copa-do-brasil", "3a-fase", 92, 1, "2027-04-29T22:00:00Z"),
];

const doubled = (rules: CupRules): CupRules => ({
  ...rules,
  advance: Object.fromEntries(Object.entries(rules.advance).map(([phase, value]) => [phase, value * 2])),
  title: rules.title * 2,
});
const values = (cups: Partial<SeasonValues["cups"]>): SeasonValues => ({ leagues: {}, cups: cups as SeasonValues["cups"] });
const fla = (v: SeasonValues) => cupsExpectedAt([FLA], matches, v, CLOSES_AT).get("FLA3");

describe("copas esperadas pela tabela configurada da temporada", () => {
  it("ipo 5: com a tabela de 2025 (valores iniciais do admin) as copas do FLA3 valem R$ 4,22", () => {
    expect(fla(values({ "copa-do-brasil": COPA_DO_BRASIL, libertadores: LIBERTADORES }))).toBe(422);
  });

  it("valores diferentes na tabela da Copa do Brasil mudam as copas esperadas (dobrar a copa dobra a parte dela)", () => {
    // Libertadores R$ 2,53125 + Copa do Brasil R$ 1,6875 × 2 = R$ 5,90625 → R$ 5,91
    expect(fla(values({ "copa-do-brasil": doubled(COPA_DO_BRASIL), libertadores: LIBERTADORES }))).toBe(591);
  });

  it("uma copa sem tabela na temporada não entra na conta", () => {
    // só a Copa do Brasil: R$ 1,6875 → R$ 1,69
    expect(fla(values({ "copa-do-brasil": COPA_DO_BRASIL }))).toBe(169);
    expect(fla(values({}))).toBe(0);
  });

});
