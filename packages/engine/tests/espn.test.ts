import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { converterEspn, derivarRodadas, type EspnEvent } from "../src/data/espn.js";
import { CLUBS, IPO_POSITIONS_2026, clubIdFromName } from "../src/data/clubs.js";
import { validateSeason, type SeasonFile } from "../src/data/season.js";
import type { Match } from "../src/engine/types.js";

// F17, T1: a conversão da ESPN (trecho congelado, sem rede) e os totais dos arquivos de 2026 baixados em 2026-11-15.

let n = 0;
function evento(o: { data: string; casa: string; fora: string; golsCasa?: number; golsFora?: number; estado?: string; fase?: string; vencedor?: "home" | "away" }): EspnEvent {
  return {
    id: String(++n),
    date: o.data,
    season: { slug: o.fase ?? "2026-brasileiro-serie-a" },
    competitions: [
      {
        status: { type: { name: o.estado ?? "STATUS_FULL_TIME" } },
        competitors: [
          { homeAway: "home", score: String(o.golsCasa ?? 0), winner: o.vencedor === "home", team: { displayName: o.casa } },
          { homeAway: "away", score: String(o.golsFora ?? 0), winner: o.vencedor === "away", team: { displayName: o.fora } },
        ],
      },
    ],
  };
}

describe("conversão da ESPN", () => {
  it("1: pontos corridos — Brasília, por jogar, adiado remarcado e rodadas", () => {
    // seis clubes em três rodadas; o jogo Santos x Bahia da rodada 1 foi adiado e jogado depois
    const eventos = [
      evento({ data: "2026-04-04T19:00Z", casa: "Flamengo", fora: "Palmeiras", golsCasa: 2, golsFora: 1 }),
      evento({ data: "2026-04-04T21:00Z", casa: "Santos", fora: "Bahia", estado: "STATUS_POSTPONED" }),
      evento({ data: "2026-04-04T22:00Z", casa: "Grêmio", fora: "Internacional", golsCasa: 1, golsFora: 0 }),
      evento({ data: "2026-04-11T19:00Z", casa: "Palmeiras", fora: "Santos", golsCasa: 0, golsFora: 0 }),
      evento({ data: "2026-04-11T21:00Z", casa: "Bahia", fora: "Flamengo", golsCasa: 1, golsFora: 3 }),
      evento({ data: "2026-04-18T19:00Z", casa: "Flamengo", fora: "Santos", estado: "STATUS_SCHEDULED" }),
      evento({ data: "2026-04-18T21:00Z", casa: "Palmeiras", fora: "Bahia", estado: "STATUS_SCHEDULED" }),
      // o adiado, jogado no meio da semana seguinte à rodada 3
      evento({ data: "2026-04-15T22:00Z", casa: "Santos", fora: "Bahia", golsCasa: 3, golsFora: 2 }),
    ];
    const { arquivo, resumo } = converterEspn("brasileirao-b", eventos, 2026, "2026-11-15");
    expect(resumo).toMatchObject({ eventos: 8, jogados: 5, porJogar: 2, adiados: 1, adiadosRemarcados: 1, cancelados: 0 });
    const ms = arquivo.matches;
    expect(ms).toHaveLength(7); // o evento antigo do adiado sai: vale o jogo remarcado
    const primeiro = ms[0]!;
    expect(primeiro).toMatchObject({ competition: "brasileirao-b", kickoff: "2026-04-04T16:00:00-03:00", status: "finished", homeGoals: 2, awayGoals: 1, round: 1 });
    const remarcado = ms.find((m) => m.home === "SAN3" && m.away === "BAH3")!;
    expect(remarcado).toMatchObject({ round: 1, status: "finished", homeGoals: 3, awayGoals: 2, postponed: true });
    const porJogar = ms.filter((m) => m.status === "scheduled");
    expect(porJogar.map((m) => [m.homeGoals, m.awayGoals])).toEqual([[null, null], [null, null]]);
    expect(new Set(ms.map((m) => m.id)).size).toBe(7);
  });

  it("1: adiado sem data nova fica agendado e marcado", () => {
    const eventos = [
      evento({ data: "2026-04-04T19:00Z", casa: "Flamengo", fora: "Palmeiras", golsCasa: 1, golsFora: 1 }),
      evento({ data: "2026-04-04T21:00Z", casa: "Santos", fora: "Bahia", estado: "STATUS_POSTPONED" }),
    ];
    const { arquivo, resumo } = converterEspn("brasileirao-b", eventos, 2026, "2026-11-15");
    expect(resumo).toMatchObject({ adiados: 1, adiadosRemarcados: 0, porJogar: 1 });
    expect(arquivo.matches.find((m) => m.home === "SAN3")).toMatchObject({ status: "scheduled", postponed: true, homeGoals: null });
  });

  it("23: jogo em andamento fica agendado, sem placar final, e guarda o placar parcial", () => {
    const eventos = [
      evento({ data: "2026-11-18T22:30Z", casa: "Flamengo", fora: "Palmeiras", golsCasa: 1, golsFora: 0, estado: "STATUS_SECOND_HALF" }),
      evento({ data: "2026-11-18T22:30Z", casa: "Santos", fora: "Bahia", golsCasa: 2, golsFora: 2, estado: "STATUS_HALFTIME" }),
      evento({ data: "2026-11-19T22:30Z", casa: "Grêmio", fora: "Internacional", estado: "STATUS_SCHEDULED" }),
      evento({ data: "2026-11-17T22:30Z", casa: "Fortaleza", fora: "Sport", golsCasa: 1, golsFora: 1 }),
    ];
    const { arquivo, resumo } = converterEspn("brasileirao-b", eventos, 2026, "2026-11-18");
    const ms = arquivo.matches;
    const fla = ms.find((m) => m.home === "FLA3")!;
    expect(fla).toMatchObject({ status: "scheduled", homeGoals: null, awayGoals: null, parcial: { homeGoals: 1, awayGoals: 0 } });
    expect(ms.find((m) => m.home === "SAN3")).toMatchObject({ status: "scheduled", parcial: { homeGoals: 2, awayGoals: 2 } });
    // quem ainda não começou e quem acabou não têm placar parcial
    expect(ms.find((m) => m.home === "GRE3")!.parcial).toBeUndefined();
    expect(ms.find((m) => m.home === "FOR3")!.parcial).toBeUndefined();
    expect(resumo).toMatchObject({ jogados: 1, porJogar: 3 });
  });

  it("1: copa — fases, pênaltis e clube de fora", () => {
    const eventos = [
      evento({ data: "2026-05-01T22:00Z", casa: "Lanús", fora: "Flamengo", golsCasa: 1, golsFora: 1, estado: "STATUS_FINAL_PEN", vencedor: "away", fase: "round-of-16" }),
      evento({ data: "2026-11-21T22:30Z", casa: "Atlético-MG", fora: "Boca Juniors", estado: "STATUS_SCHEDULED", fase: "final" }),
      evento({ data: "2026-03-01T22:30Z", casa: "Palmeiras", fora: "Santos", golsCasa: 2, golsFora: 0, fase: "fifth-round" }),
    ];
    const { arquivo, resumo } = converterEspn("sul-americana", eventos, 2026, "2026-11-15");
    const [b, a, c] = arquivo.matches as Match[];
    expect(b).toMatchObject({ phase: "5a-fase", status: "finished" });
    expect(b!.winner).toBeUndefined(); // vencedor só vale nos pênaltis e na final
    expect(a).toMatchObject({ phase: "oitavas", home: "EXT-LANUS", away: "FLA3", winner: "FLA3" });
    expect(c).toMatchObject({ phase: "final", status: "scheduled", homeGoals: null });
    expect(resumo.ultimoJogado).toBe("2026-05-01T19:00:00-03:00");
    expect(() => converterEspn("sul-americana", [evento({ data: "2026-01-01T20:00Z", casa: "A", fora: "B", fase: "fase-nova" })], 2026, "x")).toThrow(/Fase desconhecida/);
  });

  it("1: as rodadas saem das janelas do calendário", () => {
    const h = 3_600_000;
    const jogos = [
      { chave: "a", t: 0, home: "A", away: "B" },
      { chave: "b", t: 2 * h, home: "C", away: "D" },
      { chave: "c", t: 24 * 7 * h, home: "A", away: "C" },
      { chave: "d", t: 24 * 7 * h + 2 * h, home: "B", away: "D" },
      { chave: "adiado", t: 24 * 10 * h, home: "A", away: "D" }, // fora da janela: vai para a rodada em que os dois ainda não jogaram
      { chave: "e", t: 24 * 14 * h, home: "A", away: "B" },
      { chave: "f", t: 24 * 14 * h + h, home: "C", away: "D" },
    ];
    const r = derivarRodadas(jogos);
    expect([...r.entries()]).toEqual(expect.arrayContaining([["a", 1], ["b", 1], ["c", 2], ["d", 2], ["e", 3], ["f", 3]]));
    // adiado: A e D já jogaram nas rodadas 1 (A) e 2 (D)... A joga em todas; resta a nenhuma, então vai para a rodada mais próxima (2)
    expect(r.get("adiado")).toBeGreaterThanOrEqual(2);
  });
});

describe("clubes de 2026", () => {
  it("2: os quatro promovidos têm ticker e a tabela do IPO de 2026 vai de 1 a 20", () => {
    for (const [id, nome] of [["CAP3", "Athletico-PR"], ["CHA3", "Chapecoense"], ["CFC3", "Coritiba"], ["REM3", "Remo"]] as const) {
      expect(CLUBS.find((c) => c.id === id)?.name).toBe(nome);
      expect(clubIdFromName(nome)).toBe(id);
    }
    expect(Object.values(IPO_POSITIONS_2026).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const id of Object.keys(IPO_POSITIONS_2026)) expect(CLUBS.some((c) => c.id === id)).toBe(true);
  });
});

describe("arquivos de 2026 (baixados da ESPN em 2026-11-15)", () => {
  const ler = (f: string) => JSON.parse(readFileSync(new URL(`../data/${f}-2026.json`, import.meta.url), "utf8")) as SeasonFile;
  const contar = (ms: Match[]) => ({
    jogados: ms.filter((m) => m.status === "finished").length,
    porJogar: ms.filter((m) => m.status === "scheduled").length,
  });

  it("1: Série A — 380 jogos, 38 rodadas, os 3 adiados remarcados e marcados", () => {
    const a = ler("brasileirao");
    validateSeason(a);
    // em 2026-11-14 eram 340 jogados; o jogo da noite de 2026-11-14 (Chapecoense x Vasco) entrou na baixada de 2026-11-15
    expect(contar(a.matches)).toEqual({ jogados: 341, porJogar: 39 });
    const rodadas = new Map<number, number>();
    const porClube = new Map<string, number>();
    for (const m of a.matches) {
      rodadas.set(m.round!, (rodadas.get(m.round!) ?? 0) + 1);
      for (const c of [m.home, m.away]) porClube.set(c, (porClube.get(c) ?? 0) + 1);
    }
    expect([...rodadas.keys()].sort((x, y) => x - y)).toEqual(Array.from({ length: 38 }, (_, i) => i + 1));
    expect([...porClube.values()].every((v) => v === 38)).toBe(true);
    // os 3 adiados de 2026-02-25 (Chapecoense x Bahia, Vitória x Botafogo, Mirassol x Flamengo)
    const remarcados = a.matches.filter((m) => m.round === 4 && m.postponed);
    expect(remarcados.map((m) => m.kickoff.slice(0, 10)).sort()).toEqual(["2026-07-17", "2026-07-23", "2026-09-02"]);
    expect(a.clubs.map((c) => c.ipoPosition)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("1: Série B — 380 jogados e 5 por jogar", () => {
    expect(contar(ler("brasileirao-b").matches)).toEqual({ jogados: 380, porJogar: 5 });
  });

  it("1: as finais por jogar (Sul-Americana 21/11, Libertadores 28/11, Copa do Brasil 06/12)", () => {
    for (const [arq, dia] of [["sul-americana", "2026-11-21"], ["libertadores", "2026-11-28"], ["copa-do-brasil", "2026-12-06"]] as const) {
      const por = ler(arq).matches.filter((m) => m.status === "scheduled");
      expect(por).toHaveLength(1);
      expect(por[0]).toMatchObject({ phase: "final", homeGoals: null });
      expect(por[0]!.kickoff.slice(0, 10)).toBe(dia);
    }
  });
});
