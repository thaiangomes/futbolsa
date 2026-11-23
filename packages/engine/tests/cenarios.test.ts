import { describe, expect, it } from "vitest";
import { runScenarios, type ScenarioInput } from "../src/engine/cenarios.js";
import { prepareCups } from "../src/engine/fairValue.js";
import { loadSeason } from "../src/data/season.js";
import { BRASILEIRAO_A } from "../src/engine/dividends.js";
import type { Match } from "../src/engine/types.js";
import { LeagueView } from "../src/sim/leagueView.js";
import { DEFAULT_SLOT_RULES, type SlotRules } from "../src/engine/vagas.js";
import { defaultRunConfig } from "../src/sim/regressao.js";

// Critérios 6, 7, 11 e 12 de "Vagas e copas no valor justo dos bots".

const AGORA = Date.parse("2026-11-20T21:00:00-03:00");
const clubes = ["PAL", "C2", "C3", "C4", "C5", "C6"];

function jogo(id: string, home: string, away: string, over: Partial<Match> = {}): Match {
  return { id, competition: "brasileirao-a", kickoff: "2026-12-01T19:00:00-03:00", home, away, homeGoals: null, awayGoals: null, status: "scheduled", ...over };
}

function liga(): Match[] {
  const out: Match[] = [];
  for (const a of clubes) for (const b of clubes) if (a !== b) out.push(jogo(`${a}-${b}`, a, b, { round: 1 }));
  return out;
}

const forca = (id: string) => (id === "PAL" ? 3 : id === "C2" ? 2 : 1);

const regras: SlotRules = {
  destinations: [{ destination: "libertadores", tableSlots: 1, routes: [{ cup: "libertadores", result: "champion" }] }],
};

function copa(): ReturnType<typeof prepareCups> {
  const j = (id: string, home: string, away: string, over: Partial<Match> = {}): Match =>
    jogo(id, home, away, { competition: "libertadores", phase: "semifinal", kickoff: "2026-11-20T19:00:00-03:00", ...over });
  return prepareCups([
    {
      matches: [j("s1", "PAL", "FORA1"), j("s2", "FORA2", "FORA3")],
      rules: { phases: ["semifinal", "final"], advance: { semifinal: 100 }, title: 500 },
    },
  ]);
}

function entrada(over: Partial<ScenarioInput> = {}): ScenarioInput {
  return {
    now: AGORA,
    clubIds: clubes,
    rules: { perPoint: 10, placement: [], qualification: { libertadores: 300, sulamericana: 100 } },
    leagueMatches: liga(),
    cups: copa(),
    live: [],
    strength: forca,
    slots: regras,
    scenarios: 400,
    seed: 11,
    ...over,
  };
}

describe("valor justo por cenários", () => {
  it("a mesma entrada e a mesma semente dão o mesmo resultado", () => {
    expect(runScenarios(entrada())).toEqual(runScenarios(entrada()));
  });

  it("um gol do Palmeiras na semifinal da Libertadores aumenta a chance de vaga de quem vem logo atrás", () => {
    const parcial = (gols: number) => [{ home: "PAL", away: "FORA1", homeGoals: gols, awayGoals: 0, minute: 85 }];
    const sem = runScenarios(entrada({ live: parcial(0) })).get("C2")!.pLibertadores;
    const com = runScenarios(entrada({ live: parcial(2) })).get("C2")!.pLibertadores;
    expect(com).toBeGreaterThan(sem);
    // o Palmeiras também passa a esperar mais dividendos de copa
    const palSem = runScenarios(entrada({ live: parcial(0) })).get("PAL")!.cupFuture;
    const palCom = runScenarios(entrada({ live: parcial(2) })).get("PAL")!.cupFuture;
    expect(palCom).toBeGreaterThan(palSem);
  });

  it("sem regras montadas, as vagas são as 6 + 6 da tabela e o bônus acompanha a colocação", () => {
    const r = runScenarios(entrada({ cups: [], slots: DEFAULT_SLOT_RULES }));
    expect(r.get("PAL")!.pLibertadores).toBeGreaterThan(0.9);
    expect(r.get("PAL")!.pRelegated).toBe(0);
  });

  it("a penalização só pesa em quem tem chance de cair", () => {
    const r = runScenarios(entrada({ rules: { perPoint: 10, placement: [], penalty: [0, 0, 0, 0, 100, 100] } }));
    expect(r.get("PAL")!.penalty).toBeLessThan(r.get("C6")!.penalty);
    expect(r.get("PAL")!.pRelegated).toBeLessThan(0.05);
  });

  it("Série A de 20 clubes e três copas, 500 cenários: leva menos de 2 segundos", () => {
    const season = loadSeason("data/brasileirao-2025.json");
    const { cups } = defaultRunConfig(1);
    const inicio = Date.now();
    const r = runScenarios({
      now: Date.parse("2025-03-01T00:00:00-03:00"),
      clubIds: season.clubs.map((c) => c.id),
      rules: BRASILEIRAO_A,
      leagueMatches: season.matches,
      cups: prepareCups(cups!),
      live: [],
      strength: () => 1.35,
      slots: DEFAULT_SLOT_RULES,
      scenarios: 500,
      seed: 1,
    });
    expect(Date.now() - inicio).toBeLessThan(2000);
    const totalL = [...r.values()].reduce((a, c) => a + c.pLibertadores, 0);
    expect(totalL).toBeCloseTo(6, 5);
  });
});

describe("a visão do campeonato com cenários", () => {
  const montar = (cenarios: boolean) => {
    const view = new LeagueView(clubes, { perPoint: 10, placement: [], qualification: { libertadores: 300, sulamericana: 100 } }, liga());
    view.now = AGORA;
    view.buybackMultiple = 1.5;
    view.setCups([
      {
        matches: [
          { ...jogo("s1", "PAL", "FORA1"), competition: "libertadores", phase: "semifinal", kickoff: "2026-11-20T19:00:00-03:00" },
          { ...jogo("s2", "FORA2", "FORA3"), competition: "libertadores", phase: "semifinal", kickoff: "2026-11-20T19:00:00-03:00" },
        ],
        rules: { phases: ["semifinal", "final"], advance: { semifinal: 100 }, title: 500 },
      },
    ]);
    if (cenarios) view.setScenarios({ slots: regras, count: 400 });
    return view;
  };
  const parcial = [{ home: "PAL", away: "FORA1", homeGoals: 2, awayGoals: 0, minute: 85 }];

  it("o valor justo dos bots reage ao placar de um jogo de copa de outro clube", () => {
    const antes = montar(true);
    const depois = montar(true);
    depois.setLive(parcial);
    expect(depois.fairValue("C2")).toBeGreaterThan(antes.fairValue("C2"));
  });

  it("sem cenários ligados, o jogo de copa não mexe no valor justo (a conta de sempre)", () => {
    const antes = montar(false);
    const depois = montar(false);
    depois.setLive(parcial);
    expect(depois.fairValue("C2")).toBe(antes.fairValue("C2"));
  });
});
