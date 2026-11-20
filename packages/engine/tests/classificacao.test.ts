import { describe, expect, it } from "vitest";
import {
  BRASILEIRAO_A,
  BRASILEIRAO_A_2026,
  placementWithQualification,
  projectedQualification,
  QUALIFICATION_SLOTS,
  scaleLeagueRules,
  scheduleLeaguePayouts,
  type LeagueRules,
} from "../src/engine/dividends.js";
import { buybackEvents } from "../src/engine/buyback.js";
import { diffEvents, settle } from "../src/engine/payoutDiff.js";
import { eventsFor, type EventsInput } from "../src/engine/payoutEvents.js";
import { fairValue, projectLeague } from "../src/engine/fairValue.js";
import { ipoBand, placementUplift } from "../src/engine/ipoBand.js";
import type { Match } from "../src/engine/types.js";

const clubs = Array.from({ length: 20 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`);
const final: Match = {
  id: "f",
  competition: "brasileirao-a",
  round: 38,
  kickoff: "2027-12-05T16:00:00-03:00",
  home: "C01",
  away: "C02",
  homeGoals: 1,
  awayGoals: 0,
  status: "finished",
};
const base = (extra: Partial<EventsInput> = {}): EventsInput => ({
  matches: [final],
  standings: { "brasileirao-a": clubs },
  values: { leagues: { "brasileirao-a": BRASILEIRAO_A }, cups: {} },
  listed: new Set(clubs),
  ...extra,
});
const perClub = (events: { kind: string; clubId: string; perShare: number }[], kind: string) =>
  Object.fromEntries(events.filter((e) => e.kind === kind).map((e) => [e.clubId, e.perShare]));

describe("tabela de dividendos da Série A de 2026-11-20", () => {
  it("colocação do 1º ao 16º, bônus de R$ 3,00 e R$ 1,00 e penalização de R$ 1,00 para os quatro últimos", () => {
    expect(BRASILEIRAO_A.perPoint).toBe(10);
    expect(BRASILEIRAO_A.placement).toEqual([1000, 700, 500, 450, 400, 350, 300, 270, 240, 210, 180, 150, 120, 90, 60, 30]);
    expect(BRASILEIRAO_A.qualification).toEqual({ libertadores: 300, sulamericana: 100 });
    expect(BRASILEIRAO_A.penalty).toEqual([...Array(16).fill(0), 100, 100, 100, 100]);
  });

  it("a projeção dá a Libertadores ao 1º–6º, a Sul-Americana ao 7º–12º e nada a partir do 13º", () => {
    expect(QUALIFICATION_SLOTS).toEqual({ libertadores: 6, sulamericana: 6 });
    expect([1, 6, 7, 12, 13, 20].map((r) => projectedQualification(BRASILEIRAO_A, r))).toEqual([300, 300, 100, 100, 0, 0]);
    expect(projectedQualification(BRASILEIRAO_A_2026, 1)).toBe(0);
    expect(placementWithQualification(BRASILEIRAO_A, 1)).toBe(1300);
    expect(placementWithQualification(BRASILEIRAO_A, 12)).toBe(250);
    expect(placementWithQualification(BRASILEIRAO_A, 17)).toBe(0);
  });

  it("a simulação paga o bônus projetado junto com a colocação, no fechamento", () => {
    const payouts = scheduleLeaguePayouts([final], BRASILEIRAO_A);
    expect(perClub(payouts, "qualification")).toMatchObject({ C01: 300, C02: 300 });
    expect(perClub(payouts, "placement")).toMatchObject({ C01: 1000, C02: 700 });
  });

  it("scaleLeagueRules multiplica colocação, bônus e penalização", () => {
    const half = scaleLeagueRules(BRASILEIRAO_A, 0.5);
    expect(half.perPoint).toBe(5);
    expect(half.qualification).toEqual({ libertadores: 150, sulamericana: 50 });
    expect(half.penalty![17]).toBe(50);
  });
});

describe("eventsFor: classificação para o ano seguinte e rebaixamento", () => {
  const marked = { libertadores: new Set(["C01", "C03"]), sulamericana: new Set(["C03", "C07"]) };

  it("paga só o que o admin marcou; quem está nas duas recebe só a Libertadores", () => {
    const { events } = eventsFor(base({ qualified: marked }));
    expect(perClub(events, "qualification")).toEqual({ C01: 300, C03: 300, C07: 100 });
    expect(events.find((e) => e.kind === "qualification" && e.clubId === "C07")!.reason).toMatch(/Sul-Americana/);
  });

  it("sem a marcação do admin não há evento de classificação", () => {
    expect(eventsFor(base()).events.some((e) => e.kind === "qualification")).toBe(false);
  });

  it("clube não listado não recebe o bônus", () => {
    const { events } = eventsFor(base({ qualified: marked, listed: new Set(clubs.filter((c) => c !== "C01")) }));
    expect(perClub(events, "qualification")).toEqual({ C03: 300, C07: 100 });
  });

  it("os quatro últimos da classificação oficial têm evento de rebaixamento de −R$ 1,00 por ação", () => {
    const { events } = eventsFor(base());
    expect(perClub(events, "relegation")).toEqual({ C17: -100, C18: -100, C19: -100, C20: -100 });
    expect(events.find((e) => e.kind === "relegation")!.key).toBe("relegation|brasileirao-a|fim|C17");
  });

  it("sem classificação oficial importada, não há rebaixamento nem classificação", () => {
    const { events } = eventsFor(base({ standings: {}, qualified: marked }));
    expect(events.some((e) => e.kind === "relegation" || e.kind === "qualification")).toBe(false);
  });

  it("a recompra conta o bônus de classificação, mas não a penalização", () => {
    const { events } = eventsFor(base({ qualified: marked }));
    const buyback = Object.fromEntries(buybackEvents(events, new Set(clubs), 15_000, 9e12).map((e) => [e.clubId, e.perShare]));
    expect(buyback["C01"]).toBe(Math.round((30 + 1000 + 300) * 1.5)); // 3 pontos + colocação + Libertadores
    expect(buyback["C20"]).toBe(0); // o −R$ 1,00 do rebaixamento não entra na base
  });

  it("o rebaixamento entra na correção como estorno, e o débito sai do caixa pelo mesmo cálculo", () => {
    const before = eventsFor(base()).events;
    // C16 e C20 trocam de lugar: C16 passa a rebaixado (−R$ 1,00) e C20 deixa de ser (devolve o débito)
    const swapped = [...clubs.slice(0, 15), "C20", ...clubs.slice(16, 19), "C16"];
    const changes = diffEvents(before, eventsFor(base({ standings: { "brasileirao-a": swapped } })).events);
    const c16 = changes.find((c) => c.clubId === "C16" && c.kind === "relegation")!;
    expect(c16).toMatchObject({ before: 0, after: -100, delta: -100 });
    const c20 = changes.find((c) => c.clubId === "C20" && c.kind === "relegation")!;
    expect(c20).toMatchObject({ before: -100, after: 0, delta: 100 });
    expect(settle([c16], () => new Map([["w1", 50]]))[0]).toMatchObject({ walletId: "w1", amount: -5000 });
  });
});

describe("valor justo com a tabela nova", () => {
  const ids = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const rules: LeagueRules = {
    perPoint: 10,
    placement: [1000, 700, 500, 450, 400, 350, 300, 270],
    qualification: { libertadores: 300, sulamericana: 100 },
    penalty: [0, 0, 0, 0, 0, 0, 100, 100],
  };
  const input = (clubId: string, r: LeagueRules) => ({
    projection: projectLeague([], ids, 14),
    clubId,
    rules: r,
    buybackMultiple: 1.5,
    closedPoints: 0,
    placementClosed: false,
    cupClosed: 0,
    cupExpected: 0,
  });
  const sem = { perPoint: 10, placement: rules.placement };

  it("soma o bônus projetado à colocação (e à base da recompra); a penalização só abate o valor do rebaixado", () => {
    // sem jogos, todos empatam e a projeção os ordena por ordem de lista: A é o 1º e H o 8º
    expect(fairValue(input("A", rules)) - fairValue(input("A", sem))).toBe(300 + Math.round(1.5 * 300));
    // H é o 8º: a Sul-Americana (R$ 1,00 e mais 1,5× na recompra) menos a penalização de R$ 1,00
    expect(fairValue(input("H", rules)) - fairValue(input("H", sem))).toBe(100 + 150 - 100);
  });

  it("com a colocação já fechada, nem o bônus nem a penalização entram no valor, mas a recompra ainda vê o bônus", () => {
    const closed = (r: LeagueRules) => fairValue({ ...input("A", r), placementClosed: true });
    expect(closed(rules) - closed(sem)).toBe(Math.round(1.5 * 300));
  });
});

describe("faixa do IPO acompanha o dividendo maior", () => {
  it("o aumento é a colocação da tabela nova (com o bônus projetado) menos a de 2026, sem a penalização", () => {
    expect(placementUplift(1, BRASILEIRAO_A)).toBe(1300 - 500);
    expect(placementUplift(6, BRASILEIRAO_A)).toBe(350 + 300 - 270);
    expect(placementUplift(10, BRASILEIRAO_A)).toBe(210 + 100 - 150);
    expect(placementUplift(17, BRASILEIRAO_A)).toBe(0); // 17º–20º: tabela zero, a penalização não entra
    expect(placementUplift(21, BRASILEIRAO_A)).toBe(0); // promovido usa o preço do 17º
    expect(placementUplift(null, BRASILEIRAO_A)).toBe(0); // Clube dos Treze na Série B usa o 20º
    expect(placementUplift(1, BRASILEIRAO_A_2026)).toBe(0);
  });

  it("o centro sobe o aumento × (1 + recompra); sem aumento a faixa é a de antes", () => {
    const antes = ipoBand({ placement: 1, cupExpected: 0, buybackBp: 15_000 });
    const depois = ipoBand({ placement: 1, cupExpected: 0, buybackBp: 15_000, placementUplift: placementUplift(1, BRASILEIRAO_A) });
    expect(antes.center).toBe(5000);
    expect(depois.center).toBe(5000 + 2000); // R$ 8,00 × 2,5
    expect(depois.ceiling).toBe(Math.round(7000 * 1.4));
  });
});
