import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { clubs } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { resolveClub } from "../../src/modules/admin/results/club-resolver.js";
import {
  convertEspnEvents,
  convertEspnStandings,
  deriveRounds,
  EspnSource,
} from "../../src/modules/admin/results/sources/espn.js";
import {
  convertFootballDataMatches,
  convertFootballDataStandings,
  FootballDataSource,
} from "../../src/modules/admin/results/sources/football-data.js";
import { normalizeClubName } from "../../src/modules/admin/results/club-resolver.js";
import { seedSeason } from "../support/fixtures.js";
import { useTestDatabase } from "../support/db.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));

describe("conversor da ESPN", () => {
  it("jogo encerrado vira finished, com placar, horário em UTC e a fonte", () => {
    const matches = convertEspnEvents(fixture("espn-bra2-2025.json"), "brasileirao-b");
    const first = matches[0]!;
    expect(first).toMatchObject({
      source: "espn",
      competition: "brasileirao-b",
      status: "finished",
      phase: null,
    });
    expect(first.sourceId).toMatch(/^\d+$/);
    expect(first.kickoff).toBeInstanceOf(Date);
    expect(first.kickoff.toISOString()).toMatch(/Z$/);
    expect(first.homeGoals).toBeTypeOf("number");
    expect(first.awayGoals).toBeTypeOf("number");
    expect(first.round).toBe(1);
  });

  it("admin 7 (parte): adiado vira postponed e cancelado vira cancelled, sem placar", () => {
    const postponed = convertEspnEvents(fixture("espn-bra1-2026.json"), "brasileirao-a").filter((m) => m.status === "postponed");
    expect(postponed.length).toBeGreaterThan(0);
    expect(postponed[0]).toMatchObject({ homeGoals: null, awayGoals: null });
    const sula = convertEspnEvents(fixture("espn-sulamericana-2025.json"), "sulamericana");
    const cancelled = sula.filter((m) => m.status === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ homeGoals: null, awayGoals: null });
  });

  it("jogo abandonado conta como adiado: o resultado não vale e o jogo pode ser refeito", () => {
    const lib = convertEspnEvents(fixture("espn-libertadores-2025.json"), "libertadores");
    const abandoned = lib.find((m) => m.homeName === "Colo Colo" && m.awayName === "Fortaleza");
    expect(abandoned).toMatchObject({ status: "postponed", homeGoals: null, awayGoals: null });
  });

  it("jogo marcado e ainda não jogado vira scheduled sem placar", () => {
    const scheduled = convertEspnEvents(fixture("espn-bra1-2026.json"), "brasileirao-a").filter((m) => m.status === "scheduled");
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((m) => m.homeGoals === null && m.awayGoals === null)).toBe(true);
  });

  it("copa: decidido nos pênaltis, quem passou é o vencedor que a ESPN marca; placar é o do tempo normal", () => {
    const copa = convertEspnEvents(fixture("espn-copa-2026.json"), "copa-do-brasil");
    const pens = copa.find((m) => m.phase === "1a-fase" && m.advancedName !== null)!;
    expect(pens).toMatchObject({ homeName: "Sampaio Correa RJ", awayName: "Ferroviaria" });
    expect(pens.homeGoals).toBe(1);
    expect(pens.awayGoals).toBe(1);
    expect(pens.advancedName).toBe(pens.awayName);
  });

  it("copa: a final decide quem passou mesmo sem pênaltis", () => {
    const lib = convertEspnEvents(fixture("espn-libertadores-2025.json"), "libertadores");
    const final = lib.find((m) => m.phase === "final")!;
    expect(final.advancedName).not.toBeNull();
    expect([final.homeName, final.awayName]).toContain(final.advancedName);
  });

  it("copa de 2026 com nove fases: as fases novas viram 4a-fase e 5a-fase e a final de jogo único segue 'final'", () => {
    const copa = convertEspnEvents(fixture("espn-copa-2026.json"), "copa-do-brasil");
    const phases = new Set(copa.map((m) => m.phase));
    expect(phases).toContain("4a-fase");
    expect(phases).toContain("5a-fase");
    expect(phases).toContain("final");
  });

  it("fase desconhecida da ESPN não derruba a importação: entra com o nome em minúsculas", () => {
    const body = {
      events: [
        {
          id: "9",
          date: "2027-05-01T20:00Z",
          season: { slug: "Repechage-Stage" },
          competitions: [
            {
              status: { type: { name: "STATUS_SCHEDULED" } },
              competitors: [
                { homeAway: "home", score: "0", team: { displayName: "Flamengo" } },
                { homeAway: "away", score: "0", team: { displayName: "Palmeiras" } },
              ],
            },
          ],
        },
      ],
    };
    const [match] = convertEspnEvents(body, "libertadores");
    expect(match!.phase).toBe("repechage-stage");
  });

  it("Libertadores e Sul-Americana: grupos, mata-mata e pré-fases com os nomes do motor", () => {
    const lib = convertEspnEvents(fixture("espn-libertadores-2025.json"), "libertadores");
    expect(new Set(lib.map((m) => m.phase))).toEqual(new Set(["pre-1", "grupos", "final"]));
    const sula = convertEspnEvents(fixture("espn-sulamericana-2025.json"), "sulamericana");
    expect(new Set(sula.map((m) => m.phase))).toContain("playoffs");
    expect(sula.every((m) => m.round === null)).toBe(true);
  });

  it("a rodada sai da ordem dos jogos de cada clube: cada clube joga uma vez por rodada", () => {
    const matches = convertEspnEvents(fixture("espn-bra1-2026.json"), "brasileirao-a").filter((m) => m.status === "finished");
    const seen = new Map<number, Set<string>>();
    for (const m of matches) {
      const clubsInRound = seen.get(m.round!) ?? new Set<string>();
      expect(clubsInRound.has(m.homeName), `${m.homeName} repetido na rodada ${m.round}`).toBe(false);
      expect(clubsInRound.has(m.awayName), `${m.awayName} repetido na rodada ${m.round}`).toBe(false);
      clubsInRound.add(m.homeName);
      clubsInRound.add(m.awayName);
      seen.set(m.round!, clubsInRound);
    }
  });

  it("deriveRounds: o adiado jogado depois não desloca a rodada dos outros jogos", () => {
    const d = (day: number) => new Date(Date.UTC(2027, 3, day));
    const game = (id: string, home: string, away: string, day: number) => ({ id, home, away, kickoff: d(day) });
    // rodada 1: A×B e C×D; rodada 2: A×C (B×D foi adiado); rodada 3: A×D e B×C; depois B×D (adiado)
    const rounds = deriveRounds([
      game("1", "A", "B", 1),
      game("2", "C", "D", 1),
      game("3", "A", "C", 8),
      game("4", "A", "D", 15),
      game("5", "B", "C", 15),
      game("6", "B", "D", 22),
    ]);
    expect(rounds.get("1")).toBe(1);
    expect(rounds.get("2")).toBe(1);
    expect(rounds.get("3")).toBe(2);
    expect(rounds.get("4")).toBe(3);
    // B tinha 1 jogo e C tinha 2: o jogo B×C ainda cai na rodada 3, a do adversário mais avançado
    expect(rounds.get("5")).toBe(3);
  });

  it("classificação da ESPN: posição e pontos de todos os clubes, em ordem", () => {
    const table = convertEspnStandings(fixture("espn-standings-bra2-2025.json"));
    expect(table).toHaveLength(20);
    expect(table[0]).toMatchObject({ position: 1, clubName: "Coritiba" });
    expect(table.map((r) => r.position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(table[0]!.points).toBeGreaterThan(table[19]!.points);
  });

  it("EspnSource busca o ano inteiro numa chamada, sem chave, e um dia por chamada no intervalo", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ events: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const source = new EspnSource({ fetchFn: fake });
    await source.fetchMatches("brasileirao-b", 2027);
    expect(urls).toEqual(["https://site.api.espn.com/apis/site/v2/sports/soccer/bra.2/scoreboard?dates=2027&limit=1000"]);
    urls.length = 0;
    await source.fetchMatches("sulamericana", 2027, { from: new Date("2027-05-01T00:00:00Z"), to: new Date("2027-05-03T00:00:00Z") });
    expect(urls.sort()).toEqual([
      "https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.sudamericana/scoreboard?dates=20270501&limit=1000",
      "https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.sudamericana/scoreboard?dates=20270502&limit=1000",
      "https://site.api.espn.com/apis/site/v2/sports/soccer/conmebol.sudamericana/scoreboard?dates=20270503&limit=1000",
    ]);
  });

  it("EspnSource: resposta de erro da fonte vira erro, nunca lista vazia", async () => {
    const fake = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    await expect(new EspnSource({ fetchFn: fake }).fetchMatches("brasileirao-a", 2027)).rejects.toThrow(/ESPN respondeu 500/);
  });
});

describe("conversor da football-data.org", () => {
  const body = {
    matches: [
      { id: 1, utcDate: "2027-04-10T21:30:00Z", status: "FINISHED", matchday: 1, homeTeam: { name: "CR Flamengo" }, awayTeam: { name: "SE Palmeiras" }, score: { winner: "HOME_TEAM", duration: "REGULAR", fullTime: { home: 2, away: 1 } } },
      { id: 2, utcDate: "2027-04-11T21:30:00Z", status: "AWARDED", matchday: 1, homeTeam: { name: "Botafogo FR" }, awayTeam: { name: "Santos FC" }, score: { winner: "AWAY_TEAM", duration: "REGULAR", fullTime: { home: 0, away: 3 } } },
      { id: 3, utcDate: "2027-04-12T21:30:00Z", status: "POSTPONED", matchday: 1, homeTeam: { name: "SC Corinthians Paulista" }, awayTeam: { name: "Cruzeiro EC" }, score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null } } },
      { id: 4, utcDate: "2027-04-13T21:30:00Z", status: "CANCELLED", matchday: 1, homeTeam: { name: "Grêmio FBPA" }, awayTeam: { name: "SC Internacional" }, score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null } } },
      { id: 5, utcDate: "2027-04-14T21:30:00Z", status: "FINISHED", matchday: null, stage: "QUARTER_FINALS", homeTeam: { name: "CR Vasco da Gama" }, awayTeam: { name: "Sport Club do Recife" }, score: { winner: "AWAY_TEAM", duration: "PENALTY_SHOOTOUT", fullTime: { home: 1, away: 1 } } },
      { id: 6, utcDate: "2027-04-15T21:30:00Z", status: "TIMED", matchday: 2, homeTeam: { name: "Fortaleza EC" }, awayTeam: { name: "EC Bahia" }, score: { winner: null, duration: "REGULAR", fullTime: { home: null, away: null } } },
    ],
  };

  it("FINISHED e AWARDED viram finished; CANCELLED, cancelled; POSTPONED, postponed; o resto, scheduled", () => {
    const matches = convertFootballDataMatches(body, "brasileirao-a");
    expect(matches.map((m) => m.status)).toEqual(["finished", "finished", "postponed", "cancelled", "finished", "scheduled"]);
    expect(matches[0]).toMatchObject({ source: "football-data", sourceId: "1", round: 1, homeGoals: 2, awayGoals: 1, homeName: "CR Flamengo" });
    expect(matches[2]).toMatchObject({ homeGoals: null, awayGoals: null });
  });

  it("horário em UTC e pênaltis: quem passou é o vencedor da disputa", () => {
    const matches = convertFootballDataMatches(body, "libertadores");
    expect(matches[0]!.kickoff.toISOString()).toBe("2027-04-10T21:30:00.000Z");
    expect(matches[4]).toMatchObject({ advancedName: "Sport Club do Recife", round: null });
    expect(matches[0]!.advancedName).toBeNull();
  });

  it("classificação: posição e pontos pelo quadro TOTAL", () => {
    const table = convertFootballDataStandings({
      standings: [
        { type: "HOME", table: [{ position: 1, team: { name: "X" }, points: 1 }] },
        { type: "TOTAL", table: [{ position: 1, team: { name: "CR Flamengo" }, points: 79 }, { position: 2, team: { name: "SE Palmeiras" }, points: 70 }] },
      ],
    });
    expect(table).toEqual([
      { clubName: "CR Flamengo", position: 1, points: 79 },
      { clubName: "SE Palmeiras", position: 2, points: 70 },
    ]);
  });

  it("FootballDataSource manda a chave no cabeçalho e recusa competição que o plano não cobre", async () => {
    const calls: Array<{ url: string; key: string | undefined }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, key: (init?.headers as Record<string, string>)["X-Auth-Token"] });
      return new Response(JSON.stringify({ matches: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const source = new FootballDataSource({ key: "chave-de-teste", fetchFn: fake });
    await source.fetchMatches("brasileirao-a", 2027);
    expect(calls).toEqual([{ url: "https://api.football-data.org/v4/competitions/BSA/matches?season=2027", key: "chave-de-teste" }]);
    await expect(source.fetchMatches("copa-do-brasil", 2027)).rejects.toThrow(/não cobre/);
    const forbidden = (async () => new Response('{"message":"restrito"}', { status: 403 })) as unknown as typeof fetch;
    await expect(new FootballDataSource({ key: "x", fetchFn: forbidden }).fetchMatches("brasileirao-a", 2027)).rejects.toThrow(/football-data.org respondeu 403/);
  });
});

describe("nome do clube", () => {
  it("normalizeClubName tira acento, maiúsculas e sufixos como FC e EC", () => {
    expect(normalizeClubName("Atlético-MG")).toBe("atletico-mg");
    expect(normalizeClubName("Coritiba FC")).toBe("coritiba");
    expect(normalizeClubName("Esporte Clube Bahia")).toBe("bahia");
    expect(normalizeClubName("  Vasco da Gama ")).toBe("vasco da gama");
    expect(normalizeClubName("Operário PR")).toBe("operario pr");
  });
});

describe("resolveClub", () => {
  const database = useTestDatabase(5);

  it("acha o clube listado pelo apelido do motor, com acento e sufixo", async () => {
    const { clubIds } = await seedSeason(database.db);
    const resolve = (name: string) => withTransaction(database.db, (tx) => resolveClub(tx, name));
    expect((await resolve("Atlético-MG")).id).toBe(clubIds.get("CAM3"));
    expect((await resolve("Vasco da Gama")).id).toBe(clubIds.get("VAS3"));
    expect((await resolve("CR Flamengo")).id).toBe(clubIds.get("FLA3"));
    expect((await resolve("Red Bull Bragantino")).id).toBe(clubIds.get("RBB3"));
  });

  it("clube não listado entra em clubs sem ticker, uma vez só, mesmo com sufixo ou acento diferente", async () => {
    const resolve = (name: string) => withTransaction(database.db, (tx) => resolveClub(tx, name));
    const first = await resolve("Ferroviária");
    expect(first).toMatchObject({ ticker: null, name: "Ferroviária", created: true });
    expect(await resolve("Ferroviária")).toMatchObject({ id: first.id, created: false });
    expect(await resolve("ferroviaria FC")).toMatchObject({ id: first.id, created: false });
    const rows = await database.db.select().from(clubs).where(eq(clubs.name, "Ferroviária"));
    expect(rows).toHaveLength(1);
  });
});
