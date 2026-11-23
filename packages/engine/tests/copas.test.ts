import { describe, expect, it } from "vitest";
import { groupIntoTies, groupsOf, sampleGroup, sampleTie } from "../src/engine/copas.js";
import type { Match } from "../src/engine/types.js";
import { Rng } from "../src/sim/rng.js";

// Critérios 7 a 10 de "Vagas e copas no valor justo dos bots".

const AGORA = Date.parse("2026-11-20T21:00:00-03:00");
const igual = () => 1.35;

function jogo(id: string, home: string, away: string, over: Partial<Match> = {}): Match {
  return {
    id,
    competition: "libertadores",
    phase: "semifinal",
    kickoff: "2026-11-20T19:00:00-03:00",
    home,
    away,
    homeGoals: null,
    awayGoals: null,
    status: "scheduled",
    ...over,
  };
}

/** A chance de `A` passar, em muitos sorteios. */
function chance(legs: Match[], live: (m: Match) => { homeGoals: number; awayGoals: number; minute: number } | undefined, n = 20000, strength: (id: string) => number = igual): number {
  const rng = new Rng(7);
  let wins = 0;
  for (let i = 0; i < n; i++) if (sampleTie(rng, legs, AGORA, strength, live).winner === "A") wins++;
  return wins / n;
}

describe("chance de avançar nas copas", () => {
  it("jogo único em 1 a 0 aos 90 minutos: passa sempre", () => {
    const j = jogo("1", "A", "B");
    expect(chance([j], () => ({ homeGoals: 1, awayGoals: 0, minute: 90 }))).toBe(1);
  });

  it("jogo único em 0 a 0 aos 90 minutos, forças iguais: 50% (prorrogação e pênaltis)", () => {
    const j = jogo("1", "A", "B");
    expect(chance([j], () => ({ homeGoals: 0, awayGoals: 0, minute: 90 }))).toBeCloseTo(0.5, 1);
  });

  it("perdeu a ida por 0 a 2 e perde a volta por 0 a 0 aos 60 minutos: chance menor que no apito da volta", () => {
    const ida = jogo("1", "B", "A", { status: "finished", homeGoals: 2, awayGoals: 0, kickoff: "2026-11-13T19:00:00-03:00" });
    const volta = jogo("2", "A", "B");
    const noApito = chance([ida, volta], () => undefined);
    const aos60 = chance([ida, volta], () => ({ homeGoals: 0, awayGoals: 0, minute: 60 }));
    expect(aos60).toBeLessThan(noApito);
    expect(noApito).toBeLessThan(0.3);
  });

  it("empate no agregado de um confronto terminado vale o vencedor que a fonte trouxe", () => {
    const ida = jogo("1", "B", "A", { status: "finished", homeGoals: 1, awayGoals: 1, kickoff: "2026-11-13T19:00:00-03:00" });
    const volta = jogo("2", "A", "B", { status: "finished", homeGoals: 0, awayGoals: 0, winner: "A", kickoff: "2026-11-20T19:00:00-03:00" });
    expect(chance([ida, volta], () => undefined, 200)).toBe(1);
  });

  it("clube mais forte passa mais vezes", () => {
    const j = jogo("1", "A", "B");
    const forte = chance([j], () => undefined, 20000, (id) => (id === "A" ? 2 : 1));
    expect(forte).toBeGreaterThan(0.6);
  });

  it("fase de grupos com 4 pontos de vantagem e uma rodada para o fim: passa em mais de 95%", () => {
    const antes = (id: string, home: string, away: string, h: number, a: number) =>
      jogo(id, home, away, { phase: "grupos", status: "finished", homeGoals: h, awayGoals: a, kickoff: "2026-10-01T19:00:00-03:00" });
    // A venceu os três jogos (9 pontos), B venceu um e empatou um (4 pontos), C e D com 3 pontos; falta B x C e A x D
    const jogos = [
      antes("1", "A", "B", 1, 0),
      antes("2", "A", "C", 1, 0),
      antes("3", "A", "D", 1, 0),
      antes("4", "B", "C", 2, 0),
      antes("5", "B", "D", 0, 0),
      antes("6", "C", "D", 1, 0),
      jogo("7", "C", "B", { phase: "grupos" }),
      jogo("8", "D", "A", { phase: "grupos" }),
    ];
    const rng = new Rng(3);
    let first = 0;
    for (let i = 0; i < 5000; i++) if (sampleGroup(rng, jogos, AGORA, igual, () => undefined)[0] === "A") first++;
    expect(first / 5000).toBeGreaterThan(0.95);
  });

  it("agrupa os jogos em confrontos e em grupos", () => {
    const jogos = [jogo("1", "A", "B"), jogo("2", "B", "A"), jogo("3", "C", "D")];
    expect(groupIntoTies(jogos).map((t) => t.length).sort()).toEqual([1, 2]);
    expect(groupsOf(jogos)).toHaveLength(2);
  });
});
