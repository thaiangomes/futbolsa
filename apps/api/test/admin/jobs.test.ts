import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_ERROR_MESSAGES, type CompetitionCode } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, matches, standings } from "../../src/infra/db/schema/index.js";
import { AdminLogService } from "../../src/modules/admin/log/index.js";
import { ImportRunner } from "../../src/modules/admin/results/import-runner.js";
import { ImportService } from "../../src/modules/admin/results/import.service.js";
import { NoopMarketPort, MatchesEvents } from "../../src/modules/admin/results/ports.js";
import { parseResultSources, ResultSourceRegistry } from "../../src/modules/admin/results/sources/registry.js";
import type { DateRange, ResultSource, SourceMatch, SourceStanding } from "../../src/modules/admin/results/sources/types.js";
import { StandingsService } from "../../src/modules/admin/standings/standings.service.js";
import { createAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

const HOUR = 3_600_000;
/** O relatório mostra só o código e a mensagem genérica; o texto da fonte fica no log do servidor. */
const IMPORT_FAILED = { code: "import_failed", message: ADMIN_ERROR_MESSAGES.import_failed };

/** Uma fonte de mentira: guarda as chamadas e devolve o que o teste mandou. */
class FakeSource implements ResultSource {
  readonly id = "fake";
  readonly matchCalls: Array<{ competition: CompetitionCode; range?: DateRange }> = [];
  readonly standingCalls: CompetitionCode[] = [];
  results = new Map<CompetitionCode, SourceMatch[]>();
  failFor = new Set<CompetitionCode>();
  delayMs = 0;

  async fetchMatches(competition: CompetitionCode, _year: number, range?: DateRange): Promise<SourceMatch[]> {
    this.matchCalls.push({ competition, range });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failFor.has(competition)) throw new Error(`fonte fora do ar em ${competition}`);
    return this.results.get(competition) ?? [];
  }

  async fetchStandings(competition: CompetitionCode): Promise<SourceStanding[]> {
    this.standingCalls.push(competition);
    return [];
  }
}

function game(id: string, competition: CompetitionCode, kickoff: Date, extra: Partial<SourceMatch> = {}): SourceMatch {
  const league = competition === "brasileirao-a" || competition === "brasileirao-b";
  return {
    source: "fake",
    sourceId: id,
    competition,
    round: league ? 1 : null,
    phase: league ? null : "oitavas",
    kickoff,
    status: "scheduled",
    homeName: "Flamengo",
    awayName: "Palmeiras",
    homeGoals: null,
    awayGoals: null,
    advancedName: null,
    ...extra,
  };
}

describe("tarefas de resultados", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date("2027-05-20T15:00:00Z"));
  const source = new FakeSource();
  let seasonId: number;
  let runner: ImportRunner;

  beforeAll(async () => {
    ({ seasonId } = await seedSeason(database.db));
    const events = new MatchesEvents();
    const imports = new ImportService(database.db, clock, events, new NoopMarketPort());
    const log = new AdminLogService(clock, database.db);
    const standingsService = new StandingsService(database.db, clock, log);
    runner = new ImportRunner(database.db, clock, imports, standingsService, new ResultSourceRegistry(() => source), log);
  });
  beforeEach(async () => {
    source.matchCalls.length = 0;
    source.standingCalls.length = 0;
    source.results.clear();
    source.failFor.clear();
    source.delayMs = 0;
    await database.db.delete(standings);
    await database.db.delete(matches);
  });

  const staleSnapshot = (hoursAgo: number) => ({
    status: "scheduled",
    homeGoals: null,
    awayGoals: null,
    kickoff: clock.now().toISOString(),
    fetchedAt: new Date(clock.now().getTime() - hoursAgo * HOUR).toISOString(),
  });

  async function seedDueMatch(competition: CompetitionCode, hoursAfterEnd: number, sourceId: string, hoursAgoFetched = 0.1) {
    const [{ clubIds }] = [await seedSeason(database.db)];
    const kickoff = new Date(clock.now().getTime() - (hoursAfterEnd + 2) * HOUR);
    await database.db.insert(matches).values({
      seasonId,
      competition,
      round: competition.startsWith("brasileirao") ? 3 : null,
      phase: competition.startsWith("brasileirao") ? null : "oitavas",
      homeClubId: clubIds.get("FLA3")!,
      awayClubId: clubIds.get("PAL3")!,
      kickoff,
      source: "fake",
      sourceId,
      sourceSnapshot: staleSnapshot(hoursAgoFetched),
    });
  }

  it("tarefa perdida: ao subir a API com o calendário importado há mais de 24 horas, ele roda", async () => {
    await seedDueMatch("brasileirao-a", -50, "a1", 25);
    await seedDueMatch("brasileirao-b", -50, "b1", 1);
    const reports = await runner.runCalendarIfStale();
    const called = source.matchCalls.map((c) => c.competition);
    expect(called).toContain("brasileirao-a");
    expect(called).not.toContain("brasileirao-b");
    // sem nenhum jogo importado, a competição nunca foi importada: roda também
    expect(called).toEqual(expect.arrayContaining(["copa-do-brasil", "libertadores", "sulamericana"]));
    expect(reports.every((r) => r.error === null)).toBe(true);
    // o calendário é o ano inteiro, sem intervalo de datas
    expect(source.matchCalls.every((c) => c.range === undefined)).toBe(true);
  });

  it("os placares só chamam a competição que tem jogo devido (fim previsto passado e sem placar)", async () => {
    await seedDueMatch("sulamericana", 1, "s1");
    await seedDueMatch("brasileirao-a", -3, "a-futuro");
    await runner.runScores();
    expect(source.matchCalls.map((c) => c.competition)).toEqual(["sulamericana"]);
    // o intervalo cobre o dia do jogo devido até agora
    const range = source.matchCalls[0]!.range!;
    expect(range.from.getTime()).toBeLessThanOrEqual(clock.now().getTime() - 3 * HOUR);
    expect(range.to.getTime()).toBe(clock.now().getTime());
  });

  it("depois dos placares da Série A e da Série B, importa a classificação; as copas não têm", async () => {
    await seedDueMatch("brasileirao-a", 1, "a1");
    await seedDueMatch("copa-do-brasil", 1, "c1");
    await runner.runScores();
    expect(source.standingCalls).toEqual(["brasileirao-a"]);
  });

  it("falha da fonte não derruba a rodada seguinte: as outras competições seguem e nada é apagado", async () => {
    await seedDueMatch("brasileirao-a", 1, "a1");
    await seedDueMatch("libertadores", 1, "l1");
    source.failFor.add("brasileirao-a");
    source.results.set("libertadores", [game("l1", "libertadores", new Date(clock.now().getTime() - 3 * HOUR), { status: "finished", homeGoals: 1, awayGoals: 0 })]);
    const reports = await runner.runScores();
    expect(reports.find((r) => r.competition === "brasileirao-a")).toMatchObject({ error: IMPORT_FAILED });
    expect(reports.find((r) => r.competition === "libertadores")).toMatchObject({ error: null, updated: 1 });
    expect(await database.db.select().from(matches)).toHaveLength(2);
    // a classificação não é chamada depois de uma falha dos placares
    expect(source.standingCalls).toEqual([]);
  });

  it("duas execuções ao mesmo tempo viram uma", async () => {
    await seedDueMatch("sulamericana", 1, "s1");
    source.delayMs = 150;
    const [first, second] = await Promise.all([runner.runScores(), runner.runScores()]);
    expect(source.matchCalls).toHaveLength(1);
    expect([first.length, second.length].sort()).toEqual([0, 1]);
  });

  it("importar na hora força a competição pedida e devolve o erro da fonte em vez de lançar", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    const serverLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    source.failFor.add("brasileirao-b");
    const reports = await runner.runNow(admin.id, { competition: "brasileirao-b", kind: "calendar" });
    expect(reports).toEqual([
      expect.objectContaining({ competition: "brasileirao-b", kind: "calendar", error: IMPORT_FAILED }),
    ]);
    // o detalhe da fonte vai só para o log do servidor
    expect(serverLog).toHaveBeenCalledWith(expect.stringContaining("fonte fora do ar em brasileirao-b"), expect.any(String));
    serverLog.mockRestore();
    source.failFor.clear();
    const ok = await runner.runNow(admin.id, { competition: "copa-do-brasil", kind: "scores" });
    expect(ok.map((r) => r.kind)).toEqual(["scores"]);
    expect(source.matchCalls.at(-1)!.range).toBeDefined();
  });

  it("sem temporada em andamento, nada é chamado", async () => {
    await database.db.execute(`update futbolsa.seasons set status = 'closed'`);
    expect(await runner.runCalendarIfStale()).toEqual([]);
    expect(await runner.runScores()).toEqual([]);
    await database.db.execute(`update futbolsa.seasons set status = 'preparing'`);
  });
});

describe("fontes configuradas", () => {
  it("a ESPN é a padrão em todas as competições", () => {
    const sources = parseResultSources({});
    expect(sources.forCompetition("brasileirao-a").id).toBe("espn");
    expect(sources.forCompetition("sulamericana").id).toBe("espn");
  });

  it("a football-data entra só onde a configuração manda e a chave existe", () => {
    const sources = parseResultSources({ FOOTBALL_DATA_KEY: "k", RESULT_SOURCES: "brasileirao-a=football-data" });
    expect(sources.forCompetition("brasileirao-a").id).toBe("football-data");
    expect(sources.forCompetition("brasileirao-b").id).toBe("espn");
    expect(() => parseResultSources({ RESULT_SOURCES: "brasileirao-a=football-data" })).toThrow(/FOOTBALL_DATA_KEY/);
    expect(() => parseResultSources({ RESULT_SOURCES: "brasileirao-z=espn" })).toThrow(/competição/);
  });
});

describe("POST /admin/imports/run", () => {
  const database = useTestDatabase(6);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  const source = new FakeSource();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await seedSeason(database.db);
    app = await createTestApp({
      db: database.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(ResultSourceRegistry).useValue(new ResultSourceRegistry(() => source)),
    });
  });
  afterAll(() => app.close());

  it("admin 31: só o admin importa na hora", async () => {
    await expectAdminOnly(app, database.db, { method: "POST", url: "/admin/imports/run", payload: { competition: "libertadores" } }, { okStatus: 200 });
  });

  it("importa a competição pedida e mostra o erro da fonte no relatório", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    source.failFor.add("sulamericana");
    const res = await app.inject({
      method: "POST",
      url: "/admin/imports/run",
      headers: bearer(admin.token),
      payload: { competition: "sulamericana" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reports).toEqual([expect.objectContaining({ competition: "sulamericana", error: IMPORT_FAILED })]);
    expect(res.body).not.toContain("fora do ar");
  });

  it("o corpo vazio importa todas as competições", async () => {
    source.failFor.clear();
    const admin = await createAccount(database.db, { role: "admin" });
    const res = await app.inject({ method: "POST", url: "/admin/imports/run", headers: bearer(admin.token), payload: {} });
    expect(res.statusCode).toBe(200);
    const competitions = new Set((res.json().reports as Array<{ competition: string }>).map((r) => r.competition));
    expect(competitions.size).toBe(5);
  });

  it("admin 33: importar na hora fica no registro do admin, com o pedido e o resumo de cada etapa", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    source.failFor.add("libertadores");
    const res = await app.inject({
      method: "POST",
      url: "/admin/imports/run",
      headers: bearer(admin.token),
      payload: { competition: "libertadores", kind: "calendar" },
    });
    source.failFor.clear();
    expect(res.statusCode).toBe(200);
    const rows = await database.db.select().from(adminLog).where(eq(adminLog.actorId, admin.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "import.run",
      targetType: "season",
      before: null,
      after: {
        request: { competition: "libertadores", kind: "calendar" },
        reports: [expect.objectContaining({ competition: "libertadores", kind: "calendar", inserted: 0, error: "import_failed" })],
      },
    });
    expect(rows[0]!.targetId).toMatch(/^\d+$/);
  });

  it("não existe jogo cadastrado fora da temporada: nada foi gravado", async () => {
    expect(await database.db.select().from(matches).where(eq(matches.source, "fake"))).toHaveLength(0);
  });
});
