import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRASILEIRAO_A, LeagueView, expectedPoints, finishTime, gameMinute, livePointsDelta, type Match } from "../src/index.js";

// Item 23 das melhorias da partida de teste: o placar parcial de um jogo em andamento muda o valor justo que os bots enxergam.

const file = JSON.parse(readFileSync(fileURLToPath(new URL("../data/brasileirao-2025.json", import.meta.url)), "utf8")) as {
  clubs: Array<{ id: string }>;
  matches: Match[];
};
const clubIds = file.clubs.map((c) => c.id);
const NOW = Date.parse("2025-09-01T12:00:00Z");
const finished = file.matches.filter((m) => m.status === "finished" && finishTime(m) <= NOW);
const [casa, fora] = [clubIds[0]!, clubIds[1]!];

function liga(): LeagueView {
  const v = new LeagueView(clubIds, BRASILEIRAO_A, file.matches);
  v.now = NOW;
  v.setKnownMatches(finished);
  return v;
}

describe("placar parcial (item 23)", () => {
  it("o minuto de jogo desconta o intervalo", () => {
    expect(gameMinute(0)).toBe(0);
    expect(gameMinute(30 * 60_000)).toBe(30);
    expect(gameMinute(55 * 60_000)).toBe(45); // intervalo
    expect(gameMinute(75 * 60_000)).toBe(60);
    expect(gameMinute(200 * 60_000)).toBe(90);
  });

  it("pontos esperados: sobem para quem ganha, descem para quem perde, e o jogo acabado vale o resultado", () => {
    const inicio = expectedPoints(0, 0, 0, true);
    expect(inicio).toBeGreaterThan(1.3);
    expect(inicio).toBeLessThan(1.9); // mandante: um pouco acima de 1,35
    expect(expectedPoints(0, 0, 0, false)).toBeLessThan(inicio); // fora de casa espera menos
    expect(expectedPoints(1, 0, 30, true)).toBeGreaterThan(inicio);
    expect(expectedPoints(0, 1, 30, true)).toBeLessThan(inicio);
    // o mesmo 1 a 0 vale mais quanto mais perto do fim
    expect(expectedPoints(1, 0, 80, true)).toBeGreaterThan(expectedPoints(1, 0, 30, true));
    // acabou: 3, 1 ou 0
    expect(expectedPoints(2, 1, 90, true)).toBeCloseTo(3, 10);
    expect(expectedPoints(1, 1, 90, false)).toBeCloseTo(1, 10);
    expect(expectedPoints(0, 3, 90, true)).toBeCloseTo(0, 10);
  });

  it("o efeito é a diferença para o apito inicial e é zero para quem não joga", () => {
    const jogo = { home: casa, away: fora, homeGoals: 0, awayGoals: 0, minute: 0 };
    expect(livePointsDelta(jogo, casa)).toBeCloseTo(0, 10); // 0 a 0 no apito inicial: nada muda
    expect(livePointsDelta(jogo, clubIds[2]!)).toBe(0);
    const ganhando = { ...jogo, homeGoals: 2, awayGoals: 0, minute: 70 };
    expect(livePointsDelta(ganhando, casa)).toBeGreaterThan(0.8);
    expect(livePointsDelta(ganhando, fora)).toBeLessThan(-0.3);
  });

  it("o valor justo dos bots sobe com a vitória parcial e cai com a derrota, e volta ao normal sem o jogo", () => {
    const v = liga();
    const base = v.fairValue(casa);
    const baseFora = v.fairValue(fora);
    v.setLive([{ home: casa, away: fora, homeGoals: 2, awayGoals: 0, minute: 70 }]);
    expect(v.fairValue(casa)).toBeGreaterThan(base);
    expect(v.fairValue(fora)).toBeLessThan(baseFora);
    expect(v.fairValueWith(casa, () => 1.5)).toBeGreaterThan(liga().fairValueWith(casa, () => 1.5));
    // quem não joga não muda
    const outro = clubIds[5]!;
    expect(v.fairValue(outro)).toBe(liga().fairValue(outro));
    v.setLive([]);
    expect(v.fairValue(casa)).toBe(base);
  });
});
