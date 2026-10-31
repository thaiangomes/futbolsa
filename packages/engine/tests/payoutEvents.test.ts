import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRASILEIRAO_A,
  BRASILEIRAO_B,
  computeStandings,
  COPA_DO_BRASIL,
  LIBERTADORES,
  scheduleCupPayouts,
  scheduleLeaguePayouts,
  SULAMERICANA,
  type CupRules,
} from "../src/engine/dividends.js";
import { eventsFor, type EventsInput } from "../src/engine/payoutEvents.js";
import type { SeasonValues } from "../src/engine/seasonValues.js";
import { finishTime, type Match } from "../src/engine/types.js";

const t = (iso: string) => Date.parse(iso);

let nextId = 1;
function game(
  round: number,
  kickoff: string,
  home: string,
  away: string,
  score: [number, number] | null,
  extra: Partial<Match> = {},
): Match {
  return {
    id: `m${nextId++}`,
    competition: "brasileirao-a",
    round,
    kickoff,
    home,
    away,
    homeGoals: score ? score[0] : null,
    awayGoals: score ? score[1] : null,
    status: score ? "finished" : "scheduled",
    ...extra,
  };
}

const values: SeasonValues = {
  leagues: { "brasileirao-a": BRASILEIRAO_A, "brasileirao-b": BRASILEIRAO_B },
  cups: {},
};
const everyone = (...ids: string[]) => new Set(ids);

function run(matches: Match[], extra: Partial<EventsInput> = {}) {
  return eventsFor({
    matches,
    standings: {},
    values,
    listed: everyone("FLA3", "PAL3", "COR3", "SAO3", "BOT3", "CEA3", "SPT3", "GRE3", "VAS3", "CAM3", "FLU3"),
    ...extra,
  });
}

describe("eventsFor: pontos do Brasileirão", () => {
  it("dividendos 1: vitória na rodada 5 gera R$ 0,30 por ação com o motivo '3 pontos, rodada 5'", () => {
    const { events } = run([
      game(5, "2027-05-09T16:00:00-03:00", "FLA3", "PAL3", [2, 0]),
      game(5, "2027-05-09T18:30:00-03:00", "COR3", "SAO3", [0, 0]),
    ]);
    const fla = events.find((e) => e.clubId === "FLA3");
    expect(fla).toMatchObject({
      kind: "points",
      competition: "brasileirao-a",
      perShare: 30,
      reason: "3 pontos, rodada 5",
      closedAt: finishTime(game(5, "2027-05-09T18:30:00-03:00", "X", "Y", null)),
    });
  });

  it("dividendos 2: empate paga R$ 0,10 ('1 ponto') e derrota não gera evento", () => {
    const { events } = run([
      game(6, "2027-05-16T16:00:00-03:00", "PAL3", "COR3", [1, 1]),
      game(7, "2027-05-23T16:00:00-03:00", "PAL3", "SAO3", [0, 2]),
    ]);
    const pal = events.filter((e) => e.clubId === "PAL3");
    expect(pal).toHaveLength(1);
    expect(pal[0]).toMatchObject({ perShare: 10, reason: "1 ponto, rodada 6" });
  });

  it("dividendos 3: vitória na Série B paga R$ 0,15 por ação", () => {
    const { events } = run([
      game(5, "2027-05-09T16:00:00-03:00", "GRE3", "VAS3", [1, 0], { competition: "brasileirao-b" }),
    ]);
    expect(events.find((e) => e.clubId === "GRE3")).toMatchObject({ perShare: 15, competition: "brasileirao-b" });
  });

  it("dividendos 4: rodada com um jogo ainda por terminar (não adiado) não fecha e ninguém recebe", () => {
    const jogos = [
      ...Array.from({ length: 9 }, (_, i) =>
        game(10, `2027-06-0${(i % 5) + 1}T16:00:00-03:00`, `H${i}`, `A${i}`, [1, 0]),
      ),
      game(10, "2027-06-07T16:00:00-03:00", "FLA3", "PAL3", null),
    ];
    const { events, closes } = run(jogos, { listed: new Set(jogos.flatMap((m) => [m.home, m.away])) });
    expect(events).toEqual([]);
    expect(closes["brasileirao-a"]).toBeUndefined();
  });

  it("dividendos 5 e admin 9: o jogo adiado da rodada 12 paga no fechamento da rodada 16 ('6 pontos, rodada 16, 12 (adiado)')", () => {
    const { events } = run([
      game(12, "2027-07-20T16:00:00-03:00", "FLA3", "COR3", [2, 0], { postponed: true }),
      game(16, "2027-07-21T16:00:00-03:00", "FLA3", "SAO3", [1, 0]),
    ]);
    const fla = events.filter((e) => e.clubId === "FLA3");
    expect(fla).toHaveLength(1);
    expect(fla[0]).toMatchObject({
      perShare: 60,
      reason: "6 pontos, rodada 16, 12 (adiado)",
      closedAt: t("2027-07-21T18:00:00-03:00"),
    });
  });

  it("dividendos 6: jogo adiado disputado depois da última rodada paga no fim dele e fecha o campeonato", () => {
    const { events, closes } = run(
      [
        game(38, "2027-12-05T16:00:00-03:00", "PAL3", "COR3", [0, 0]),
        game(30, "2027-12-12T16:00:00-03:00", "FLA3", "SAO3", [1, 0], { postponed: true }),
      ],
      { standings: { "brasileirao-a": ["FLA3", "PAL3", "COR3", "SAO3"] } },
    );
    const fimDoJogo = t("2027-12-12T18:00:00-03:00");
    expect(closes["brasileirao-a"]).toBe(fimDoJogo);
    const fla = events.filter((e) => e.clubId === "FLA3");
    expect(fla.map((e) => e.kind).sort()).toEqual(["placement", "points"]);
    expect(fla.every((e) => e.closedAt === fimDoJogo)).toBe(true);
    expect(events.some((e) => e.closedAt === t("2027-12-05T18:00:00-03:00") && e.kind === "placement")).toBe(false);
  });

  it("jogo cancelado não soma pontos (admin 10)", () => {
    const { events } = run([
      game(3, "2027-05-02T16:00:00-03:00", "FLA3", "PAL3", [1, 0]),
      game(3, "2027-05-02T18:30:00-03:00", "COR3", "SAO3", null, { status: "cancelled" }),
    ]);
    expect(events.filter((e) => e.clubId === "COR3" || e.clubId === "SAO3")).toEqual([]);
    expect(events.find((e) => e.clubId === "FLA3")).toBeDefined();
  });
});

describe("eventsFor: colocação e acesso pela classificação oficial", () => {
  const padrao = Array.from({ length: 20 }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);
  const oficial = ["BOT3", ...padrao.slice(1, 15), "CEA3", "SPT3", ...padrao.slice(17)];
  const jogoUnico = [game(38, "2027-12-05T16:00:00-03:00", "BOT3", "CEA3", [1, 0])];

  it("dividendos 7: 1º recebe R$ 5,00, 16º R$ 0,20 e o 17º nada", () => {
    const { events } = run(jogoUnico, { standings: { "brasileirao-a": oficial } });
    const place = Object.fromEntries(events.filter((e) => e.kind === "placement").map((e) => [e.clubId, e.perShare]));
    expect(place["BOT3"]).toBe(500);
    expect(place["CEA3"]).toBe(20);
    expect(place["SPT3"]).toBeUndefined();
  });

  it("dividendos 8: manda a classificação oficial, e não o cálculo por pontos, vitórias, saldo e gols", () => {
    // Pela tabela calculada o CAM3 está na frente (3 pontos contra 0); a oficial põe o FLU3 em 1º.
    const { events } = run([game(1, "2027-04-04T16:00:00-03:00", "CAM3", "FLU3", [1, 0])], {
      standings: { "brasileirao-a": ["FLU3", "CAM3"] },
    });
    const place = Object.fromEntries(events.filter((e) => e.kind === "placement").map((e) => [e.clubId, e.perShare]));
    expect(place).toEqual({ FLU3: 500, CAM3: 450 });
  });

  it("sem a classificação oficial importada ainda, o campeonato fecha mas a colocação não gera evento", () => {
    const { events, closes } = run(jogoUnico);
    expect(events.some((e) => e.kind === "placement")).toBe(false);
    expect(closes["brasileirao-a"]).toBe(t("2027-12-05T18:00:00-03:00"));
  });

  it("campeonato ainda com jogo agendado não paga colocação, mesmo com classificação", () => {
    const { events, closes } = run(
      [game(38, "2027-12-05T16:00:00-03:00", "BOT3", "CEA3", [1, 0]), game(38, "2027-12-05T16:00:00-03:00", "FLA3", "PAL3", null)],
      { standings: { "brasileirao-a": oficial } },
    );
    expect(events.some((e) => e.kind === "placement")).toBe(false);
    expect(closes["brasileirao-a"]).toBeUndefined();
  });

  it("dividendos 9: acesso de R$ 2,00 só para o listado entre os 4 primeiros da tabela inteira da B", () => {
    // Um clube não listado em 2º ocupa a vaga sem receber; GRE3 em 3º recebe; VAS3 em 5º não.
    const tabelaB = ["NL1", "NL2", "GRE3", "NL3", "VAS3", "NL4"];
    const { events } = run(
      [game(38, "2027-11-28T16:00:00-03:00", "GRE3", "VAS3", [1, 0], { competition: "brasileirao-b" })],
      { standings: { "brasileirao-b": tabelaB }, listed: everyone("GRE3", "VAS3") },
    );
    const acesso = events.filter((e) => e.kind === "promotion");
    expect(acesso).toEqual([expect.objectContaining({ clubId: "GRE3", perShare: 200, competition: "brasileirao-b" })]);
  });

  it("dividendos 27: clube não listado não recebe pontos nem colocação", () => {
    const { events } = run([game(5, "2027-05-09T16:00:00-03:00", "FLA3", "ZZZ9", [0, 3])], {
      listed: everyone("FLA3"),
      standings: { "brasileirao-a": ["ZZZ9", "FLA3"] },
    });
    expect(events.filter((e) => e.clubId === "ZZZ9")).toEqual([]);
    expect(events.find((e) => e.kind === "placement")).toMatchObject({ clubId: "FLA3", perShare: 450 });
  });
});

describe("eventsFor: chave estável entre versões", () => {
  it("a chave identifica (tipo, competição, rodada ou fase, clube) e não muda ao corrigir o placar", () => {
    const original = run([game(10, "2027-06-06T16:00:00-03:00", "CAM3", "BOT3", [2, 1])]).events;
    const corrigido = run([game(10, "2027-06-06T16:00:00-03:00", "CAM3", "BOT3", [1, 1])]).events;
    const cam = (es: typeof original) => es.find((e) => e.clubId === "CAM3")!;
    expect(cam(original).key).toBe(cam(corrigido).key);
    expect(cam(original).perShare).toBe(30);
    expect(cam(corrigido).perShare).toBe(10);
    // BOT3 não tinha evento e passa a ter: a chave nova aparece só na versão corrigida.
    expect(original.find((e) => e.clubId === "BOT3")).toBeUndefined();
    expect(corrigido.find((e) => e.clubId === "BOT3")!.key).toContain("BOT3");
    expect(new Set(corrigido.map((e) => e.key)).size).toBe(corrigido.length);
  });
});

describe("regressão: eventsFor × scheduleLeaguePayouts com os jogos reais de 2025", () => {
  const file = JSON.parse(readFileSync("data/brasileirao-2025.json", "utf8")) as { matches: Match[]; clubs: { id: string }[] };
  const listed = new Set(file.clubs.map((c) => c.id));
  const oficial = computeStandings(file.matches).map((r) => r.clubId);

  it("tem o mesmo (instante, clube, valor por ação, tipo) quando a classificação oficial é a calculada", () => {
    const novo = eventsFor({ matches: file.matches, standings: { "brasileirao-a": oficial }, values, listed }).events;
    const antigo = scheduleLeaguePayouts(file.matches, BRASILEIRAO_A);
    const forma = (e: { closedAt?: number; at?: number; clubId: string; perShare: number; kind: string }) =>
      `${e.closedAt ?? e.at}|${e.clubId}|${e.perShare}|${e.kind}`;
    expect(novo.map(forma).sort()).toEqual(antigo.map(forma).sort());
    expect(novo.length).toBeGreaterThan(300);
  });
});

describe("eventsFor: copas", () => {
  const copas: SeasonValues = {
    leagues: {},
    cups: { "copa-do-brasil": COPA_DO_BRASIL, libertadores: LIBERTADORES, "sul-americana": SULAMERICANA },
  };
  const jogo = (
    competition: string,
    phase: string,
    day: string,
    home: string,
    away: string,
    score: [number, number] | null,
    extra: Partial<Match> = {},
  ): Match => ({
    id: `c${nextId++}`,
    competition,
    phase,
    kickoff: `${day}T21:30:00-03:00`,
    home,
    away,
    homeGoals: score ? score[0] : null,
    awayGoals: score ? score[1] : null,
    status: score ? "finished" : "scheduled",
    ...extra,
  });
  const copaEventos = (matches: Match[], ...listados: string[]) =>
    eventsFor({ matches, standings: {}, values: copas, listed: new Set(listados) });
  const doClube = (events: ReturnType<typeof copaEventos>["events"], clubId: string) =>
    events.filter((e) => e.clubId === clubId).map((e) => [e.stage, e.kind, e.perShare]);

  it("dividendos 10: campeão que entra na 3ª fase recebe R$ 1,00, 1,50, 2,50, 4,00 e 8,00 (R$ 17,00 por ação)", () => {
    const cb = "copa-do-brasil";
    const { events } = copaEventos(
      [
        jogo(cb, "3a-fase", "2027-03-01", "COR3", "X1", [1, 0]),
        jogo(cb, "oitavas", "2027-05-01", "COR3", "X2", [1, 0]),
        jogo(cb, "quartas", "2027-06-01", "COR3", "X3", [1, 0]),
        jogo(cb, "semifinal", "2027-08-01", "COR3", "X4", [1, 0]),
        jogo(cb, "final", "2027-11-01", "COR3", "X5", [1, 0]),
      ],
      "COR3",
    );
    expect(doClube(events, "COR3")).toEqual([
      ["3a-fase", "cup_phase", 100],
      ["oitavas", "cup_phase", 150],
      ["quartas", "cup_phase", 250],
      ["semifinal", "cup_phase", 400],
      ["final", "cup_title", 800],
    ]);
    expect(events.reduce((s, e) => s + e.perShare, 0)).toBe(1_700);
  });

  it("dividendos 11: quem entra direto nas oitavas e é eliminado nelas não recebe nada da copa", () => {
    const cb = "copa-do-brasil";
    const { events } = copaEventos(
      [
        jogo(cb, "oitavas", "2027-05-01", "FLA3", "X1", [0, 1]),
        jogo(cb, "quartas", "2027-06-01", "X1", "X2", [1, 0]),
      ],
      "FLA3",
    );
    expect(events).toEqual([]);
  });

  it("dividendos 12: ida e volta só paga depois do último jogo de volta da fase (R$ 3,75)", () => {
    const lib = "libertadores";
    const jogos = (voltaFinalizada: boolean) => [
      jogo(lib, "quartas", "2027-08-13", "X1", "PAL3", [0, 1]),
      jogo(lib, "quartas", "2027-08-20", "PAL3", "X1", [1, 0]),
      jogo(lib, "quartas", "2027-08-15", "X2", "X3", [0, 0]),
      jogo(lib, "quartas", "2027-08-22", "X3", "X2", voltaFinalizada ? [1, 0] : null),
      jogo(lib, "semifinal", "2027-09-20", "PAL3", "X3", null),
    ];
    // O jogo de 20/08 terminou com o PAL3 classificado, mas ainda falta o último jogo de volta.
    expect(doClube(copaEventos(jogos(false), "PAL3").events, "PAL3")).toEqual([]);
    const pago = copaEventos(jogos(true), "PAL3").events.filter((e) => e.clubId === "PAL3");
    expect(pago).toHaveLength(1);
    expect(pago[0]).toMatchObject({ perShare: 375, stage: "quartas", closedAt: Date.parse("2027-08-22T23:30:00-03:00") });
  });

  it("dividendos 13: quem passa das preliminares e cai nos grupos da Libertadores não recebe nada", () => {
    const lib = "libertadores";
    const { events } = copaEventos(
      [
        jogo(lib, "pre-1", "2027-02-01", "BAH3", "X1", [1, 0]),
        jogo(lib, "grupos", "2027-04-01", "BAH3", "X2", [0, 2]),
        jogo(lib, "oitavas", "2027-08-01", "X2", "X3", [1, 0]),
      ],
      "BAH3",
    );
    expect(events).toEqual([]);
  });

  it("dividendos 14: Sul-Americana, o 1º do grupo recebe R$ 0,60 e o 2º R$ 0,30 nos grupos e R$ 0,30 nos playoffs", () => {
    const sa = "sul-americana";
    const { events } = copaEventos(
      [
        jogo(sa, "grupos", "2027-04-01", "FLU3", "CAM3", [1, 0]),
        jogo(sa, "playoffs", "2027-08-01", "CAM3", "X1", [1, 0]),
        jogo(sa, "oitavas", "2027-08-20", "FLU3", "CAM3", [0, 0]),
      ],
      "FLU3",
      "CAM3",
    );
    expect(doClube(events, "FLU3")).toEqual([["grupos", "cup_phase", 60]]);
    expect(doClube(events, "CAM3")).toEqual([
      ["grupos", "cup_phase", 30],
      ["playoffs", "cup_phase", 30],
    ]);
  });

  it("dividendos 15: o 3º do grupo da Libertadores que vence os playoffs da Sul-Americana recebe R$ 0,30", () => {
    const sa = "sul-americana";
    const { events } = copaEventos(
      [
        jogo(sa, "playoffs", "2027-08-01", "SAO3", "X1", [2, 0]),
        jogo(sa, "oitavas", "2027-08-20", "SAO3", "X2", [0, 0]),
      ],
      "SAO3",
    );
    expect(doClube(events, "SAO3")).toEqual([["playoffs", "cup_phase", 30]]);
  });

  it("dividendos 16: final empatada com o VAS3 campeão nos pênaltis paga o título de R$ 8,00 ao VAS3", () => {
    const cb = "copa-do-brasil";
    const { events } = copaEventos(
      [jogo(cb, "final", "2027-12-19", "VAS3", "COR3", [1, 1], { winner: "VAS3" })],
      "VAS3",
      "COR3",
    );
    expect(doClube(events, "VAS3")).toEqual([["final", "cup_title", 800]]);
    expect(doClube(events, "COR3")).toEqual([]);
  });

  it("dividendos 27: clube fora da lista que vence uma fase não gera pagamento", () => {
    const cb = "copa-do-brasil";
    const { events } = copaEventos(
      [
        jogo(cb, "quartas", "2027-06-01", "ZZZ9", "X1", [1, 0]),
        jogo(cb, "semifinal", "2027-08-01", "ZZZ9", "X2", [0, 0]),
      ],
      "FLA3",
    );
    expect(events).toEqual([]);
  });

  it("a copa fecha quando termina a decisão, e fica aberta (sem instante) enquanto a final não acontece", () => {
    const cb = "copa-do-brasil";
    const semi = jogo(cb, "semifinal", "2027-08-01", "COR3", "X1", [1, 0]);
    const aberta = copaEventos([semi, jogo(cb, "final", "2027-12-19", "COR3", "X2", null)], "COR3");
    expect(aberta.closes["copa-do-brasil"]).toBeUndefined();
    const fechada = copaEventos([semi, jogo(cb, "final", "2027-12-19", "COR3", "X2", [1, 0])], "COR3");
    expect(fechada.closes["copa-do-brasil"]).toBe(Date.parse("2027-12-19T23:30:00-03:00"));
    // Competição que nem começou também está aberta.
    expect(fechada.closes["libertadores"]).toBeUndefined();
  });
});

describe("regressão: eventsFor × scheduleCupPayouts com os jogos reais das copas de 2025", () => {
  const casos: [string, CupRules, string][] = [
    ["copa-do-brasil", COPA_DO_BRASIL, "data/copa-do-brasil-2025.json"],
    ["libertadores", LIBERTADORES, "data/libertadores-2025.json"],
    ["sul-americana", SULAMERICANA, "data/sul-americana-2025.json"],
  ];
  for (const [competition, rules, path] of casos) {
    it(`${competition}: mesmo (instante, clube, valor por ação) que a função antiga`, () => {
      const file = JSON.parse(readFileSync(path, "utf8")) as { matches: Match[] };
      const listed = new Set(file.matches.flatMap((m) => [m.home, m.away]));
      const novo = eventsFor({
        matches: file.matches,
        standings: {},
        values: { leagues: {}, cups: { [competition]: rules } },
        listed,
      }).events;
      const antigo = scheduleCupPayouts(file.matches, rules);
      const forma = (e: { closedAt?: number; at?: number; clubId: string; perShare: number }) =>
        `${e.closedAt ?? e.at}|${e.clubId}|${e.perShare}`;
      expect(novo.map(forma).sort()).toEqual(antigo.map(forma).sort());
      expect(novo.length).toBeGreaterThan(0);
    });
  }
});
