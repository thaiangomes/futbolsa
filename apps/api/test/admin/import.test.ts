import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { type Tx } from "../../src/infra/db/index.js";
import { clubs, matches, seasons } from "../../src/infra/db/schema/index.js";
import { ImportService } from "../../src/modules/admin/results/import.service.js";
import {
  type MarketPort,
  type MatchesChangedEvent,
  MatchesEvents,
  type RefreshReason,
} from "../../src/modules/admin/results/ports.js";
import type { ResultSource, SourceMatch } from "../../src/modules/admin/results/sources/types.js";
import { createTestDatabase, type TestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

class RecordingMarket implements MarketPort {
  readonly refreshes: Array<{ tickers: string[]; reason: RefreshReason }> = [];
  readonly cancelled: string[][] = [];
  async cancelHouseQuotes(_tx: Tx, tickers: readonly string[]): Promise<void> {
    this.cancelled.push([...tickers]);
  }
  async requestRefresh(_tx: Tx, tickers: readonly string[], reason: RefreshReason): Promise<void> {
    this.refreshes.push({ tickers: [...tickers], reason });
  }
}

const day = (d: number, hour = 21) => new Date(Date.UTC(2027, 3, d, hour + 3));

function league(id: string, home: string, away: string, round: number, kickoff: Date, extra: Partial<SourceMatch> = {}): SourceMatch {
  return {
    source: "espn",
    sourceId: id,
    competition: "brasileirao-a",
    round,
    phase: null,
    kickoff,
    status: "scheduled",
    homeName: home,
    awayName: away,
    homeGoals: null,
    awayGoals: null,
    advancedName: null,
    ...extra,
  };
}

describe("importação de jogos", () => {
  // um banco por teste: a chave (fonte, id da fonte) é única no banco todo, e cada teste usa os mesmos ids
  let conn: TestDatabase;
  const database = {
    get db() {
      return conn.db;
    },
    get conn() {
      return conn;
    },
  };
  afterEach(() => conn.close());
  const clock = new FixedClock(new Date("2027-04-10T12:00:00Z"));
  let seasonId: number;
  let clubIds: Map<string, number>;
  let market: RecordingMarket;
  let events: MatchesEvents;
  let published: MatchesChangedEvent[];
  let service: ImportService;

  beforeEach(async () => {
    conn = await createTestDatabase(5);
    ({ seasonId, clubIds } = await seedSeason(database.db));
    market = new RecordingMarket();
    events = new MatchesEvents();
    published = [];
    events.subscribe((e) => {
      published.push(e);
    });
    service = new ImportService(database.db, clock, events, market);
  });

  const rows = () => database.db.select().from(matches).where(eq(matches.seasonId, seasonId));

  it("insere jogos novos, com os clubes do banco, e importar de novo não muda nada", async () => {
    const batch = [
      league("1", "Flamengo", "Palmeiras", 1, day(10), { status: "finished", homeGoals: 2, awayGoals: 1 }),
      league("2", "Vasco da Gama", "Santos", 1, day(10)),
    ];
    const first = await service.importMatches(seasonId, "brasileirao-a", batch);
    expect(first).toMatchObject({ inserted: 2, updated: 0, unchanged: 0, clubsCreated: [] });
    const saved = await rows();
    expect(saved).toHaveLength(2);
    expect(saved.find((m) => m.sourceId === "1")).toMatchObject({
      homeClubId: clubIds.get("FLA3"),
      awayClubId: clubIds.get("PAL3"),
      status: "finished",
      homeGoals: 2,
      awayGoals: 1,
      manualOverride: false,
      source: "espn",
    });
    const before = saved.map((m) => ({ ...m, sourceSnapshot: undefined }));

    published.length = 0;
    market.refreshes.length = 0;
    const second = await service.importMatches(seasonId, "brasileirao-a", batch);
    expect(second).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect((await rows()).map((m) => ({ ...m, sourceSnapshot: undefined }))).toEqual(before);
    expect(published).toEqual([]);
    expect(market.refreshes).toEqual([]);
  });

  it("admin 6: placar editado à mão não é sobrescrito pela importação, e o que a fonte diz fica no snapshot", async () => {
    await service.importMatches(seasonId, "brasileirao-a", [league("1", "Flamengo", "Palmeiras", 1, day(10))]);
    await database.db
      .update(matches)
      .set({ homeGoals: 2, awayGoals: 0, status: "finished", manualOverride: true })
      .where(eq(matches.seasonId, seasonId));
    market.refreshes.length = 0;
    published.length = 0;

    const report = await service.importMatches(seasonId, "brasileirao-a", [
      league("1", "Flamengo", "Palmeiras", 1, day(10), { status: "finished", homeGoals: 1, awayGoals: 1 }),
    ]);
    expect(report).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    const [row] = await rows();
    expect(row).toMatchObject({ homeGoals: 2, awayGoals: 0, status: "finished", manualOverride: true });
    expect(row!.sourceSnapshot).toMatchObject({ status: "finished", homeGoals: 1, awayGoals: 1 });
    expect(published).toEqual([]);
    expect(market.refreshes).toEqual([]);
  });

  it("jogo cadastrado à mão e depois trazido pela fonte não duplica: liga ao da fonte e mantém os dados do admin", async () => {
    await database.db.insert(matches).values({
      seasonId,
      competition: "brasileirao-a",
      round: 3,
      homeClubId: clubIds.get("CAM3")!,
      awayClubId: clubIds.get("CRU3")!,
      kickoff: day(17),
      status: "finished",
      homeGoals: 3,
      awayGoals: 0,
      source: "manual",
      manualOverride: true,
    });
    const report = await service.importMatches(seasonId, "brasileirao-a", [
      league("77", "Atlético-MG", "Cruzeiro", 3, day(17), { status: "finished", homeGoals: 1, awayGoals: 0 }),
    ]);
    expect(report).toMatchObject({ inserted: 0, updated: 1 });
    const saved = await rows();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ source: "espn", sourceId: "77", homeGoals: 3, awayGoals: 0, manualOverride: true });
    expect(saved[0]!.sourceSnapshot).toMatchObject({ homeGoals: 1, awayGoals: 0 });
  });

  it("admin 7: jogo com nova data 23 dias depois da mediana da rodada é marcado como adiado", async () => {
    const tickers = ["FLA3", "PAL3", "VAS3", "SAN3", "COR3", "SAO3"];
    const names = ["Flamengo", "Palmeiras", "Vasco da Gama", "Santos", "Corinthians", "São Paulo"];
    const batch = [
      league("a", names[0]!, names[1]!, 5, day(12)),
      league("b", names[2]!, names[3]!, 5, day(12)),
      league("c", names[4]!, names[5]!, 5, day(12)),
    ];
    await service.importMatches(seasonId, "brasileirao-a", batch);
    expect(tickers).toHaveLength(6);
    const flags = new Map((await rows()).map((m) => [m.sourceId, m.outOfWindow]));
    expect(flags.get("a")).toBe(false);
    expect(flags.get("c")).toBe(false);
    // nova data do jogo "c": 23 dias depois da mediana da rodada
    const moved = [...batch.slice(0, 2), league("c", names[4]!, names[5]!, 5, day(12 + 23))];
    await service.importMatches(seasonId, "brasileirao-a", moved);
    const after = new Map((await rows()).map((m) => [m.sourceId, m.outOfWindow]));
    expect(after.get("c")).toBe(true);
    expect(after.get("a")).toBe(false);
    // voltando para a data da rodada, o adiado se desmarca sozinho
    await service.importMatches(seasonId, "brasileirao-a", batch.slice(0, 2).concat(league("c", names[4]!, names[5]!, 5, day(12))));
    expect((await rows()).find((m) => m.sourceId === "c")!.outOfWindow).toBe(false);
  });

  it("admin 7: jogo com manual_override não é marcado nem desmarcado pela importação", async () => {
    const names = ["Flamengo", "Palmeiras", "Vasco da Gama", "Santos", "Corinthians", "São Paulo"];
    const batch = [
      league("a", names[0]!, names[1]!, 5, day(12)),
      league("b", names[2]!, names[3]!, 5, day(12)),
      league("c", names[4]!, names[5]!, 5, day(12 + 23)),
    ];
    await service.importMatches(seasonId, "brasileirao-a", batch);
    expect((await rows()).find((m) => m.sourceId === "c")!.outOfWindow).toBe(true);
    // o admin desmarca o adiado: as duas colunas zeradas e a linha passa a ser dele
    await database.db
      .update(matches)
      .set({ outOfWindow: false, status: "scheduled", manualOverride: true })
      .where(and(eq(matches.seasonId, seasonId), eq(matches.sourceId, "c")));
    await service.importMatches(seasonId, "brasileirao-a", batch);
    expect((await rows()).find((m) => m.sourceId === "c")).toMatchObject({ outOfWindow: false, manualOverride: true });
  });

  it("admin 6 e 7: edição do admin que termina no meio da importação não tem o adiado remarcado pela importação", async () => {
    const batch = [
      league("a", "Flamengo", "Palmeiras", 5, day(12)),
      league("b", "Vasco da Gama", "Santos", 5, day(12)),
      league("c", "Corinthians", "São Paulo", 5, day(12)),
    ];
    await service.importMatches(seasonId, "brasileirao-a", batch);
    expect((await rows()).find((m) => m.sourceId === "c")).toMatchObject({ outOfWindow: false, manualOverride: false });

    // o admin edita o jogo "c" numa transação que ainda não terminou (segura a linha)
    const admin = await database.conn.pool.connect();
    try {
      await admin.query("begin");
      await admin.query(
        "update futbolsa.matches set manual_override = true, status = 'scheduled', out_of_window = false where season_id = $1 and source_id = 'c'",
        [seasonId],
      );
      // a fonte muda a data de "a" e "b" para 23 dias depois: pela mediana, "c" ficaria fora da janela
      const running = service.importMatches(seasonId, "brasileirao-a", [
        league("a", "Flamengo", "Palmeiras", 5, day(12 + 23)),
        league("b", "Vasco da Gama", "Santos", 5, day(12 + 23)),
      ]);
      // espera a importação parar na linha travada pelo admin, e só então o admin termina
      for (let i = 0; i < 100; i++) {
        const res = await database.conn.pool.query(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (res.rows[0].n > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await admin.query("commit");
      await running;
    } finally {
      admin.release();
    }
    expect((await rows()).find((m) => m.sourceId === "c")).toMatchObject({ manualOverride: true, outOfWindow: false });
  });

  it("a fonte que diz POSTPONED marca o jogo como adiado; o motor lê adiado = status adiado ou fora da janela", async () => {
    await service.importMatches(seasonId, "brasileirao-a", [
      league("p", "Flamengo", "Palmeiras", 2, day(14), { status: "postponed" }),
    ]);
    expect((await rows())[0]).toMatchObject({ status: "postponed" });
  });

  it("clubes que a fonte traz e o jogo não lista entram em clubs sem ticker, e o relatório os lista", async () => {
    const report = await service.importMatches(seasonId, "brasileirao-b", [
      league("x", "Ypiranga FC", "Ferroviária", 1, day(10), { competition: "brasileirao-b" }),
    ]);
    expect(report.clubsCreated.sort()).toEqual(["Ferroviária", "Ypiranga FC"]);
    const created = await database.db.select().from(clubs).where(eq(clubs.name, "Ferroviária"));
    expect(created).toEqual([expect.objectContaining({ ticker: null })]);
  });

  it("MatchesChangedEvent e MarketPort.requestRefresh só saem depois do COMMIT e só quando um placar mudou", async () => {
    let visibleInHandler: number | undefined;
    events.subscribe(async () => {
      // se o evento saísse antes do COMMIT, outra conexão não veria os jogos
      visibleInHandler = (await database.db.select().from(matches).where(eq(matches.seasonId, seasonId))).length;
    });
    await service.importMatches(seasonId, "brasileirao-a", [league("1", "Flamengo", "Palmeiras", 1, day(10))]);
    // jogo novo e agendado, sem placar: o evento sai, mas nenhum placar mudou e a casa não repõe nada
    expect(published).toEqual([expect.objectContaining({ scoreChanged: false })]);
    expect(market.refreshes).toEqual([]);
    published.length = 0;

    await service.importMatches(seasonId, "brasileirao-a", [
      league("1", "Flamengo", "Palmeiras", 1, day(10), { status: "finished", homeGoals: 2, awayGoals: 1 }),
    ]);
    expect(visibleInHandler).toBe(1);
    expect(published).toEqual([
      expect.objectContaining({
        seasonId,
        competition: "brasileirao-a",
        scoreChanged: true,
        clubIds: expect.arrayContaining([clubIds.get("FLA3")!, clubIds.get("PAL3")!]),
      }),
    ]);
    expect(market.refreshes).toEqual([{ tickers: ["FLA3", "PAL3"], reason: "score" }]);

    // o placar corrige: de novo evento e reposição
    await service.importMatches(seasonId, "brasileirao-a", [
      league("1", "Flamengo", "Palmeiras", 1, day(10), { status: "finished", homeGoals: 1, awayGoals: 1 }),
    ]);
    expect(published).toHaveLength(2);
    expect(market.refreshes).toHaveLength(2);
  });

  it("mudança de data sem placar publica o evento (a rodada pode fechar de outra forma), mas não pede reposição", async () => {
    await service.importMatches(seasonId, "brasileirao-a", [league("1", "Flamengo", "Palmeiras", 1, day(10))]);
    published.length = 0;
    await service.importMatches(seasonId, "brasileirao-a", [league("1", "Flamengo", "Palmeiras", 1, day(11))]);
    expect(published).toEqual([expect.objectContaining({ scoreChanged: false })]);
    expect(market.refreshes).toEqual([]);
  });

  it("admin 18: temporada encerrada não recebe importação", async () => {
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, seasonId));
    await expect(
      service.importMatches(seasonId, "brasileirao-a", [league("1", "Flamengo", "Palmeiras", 1, day(10))]),
    ).rejects.toMatchObject({ code: "season_closed" });
    expect(await rows()).toHaveLength(0);
  });

  it("a fonte fora do ar não apaga nem altera jogos, e nenhuma chamada à fonte acontece dentro da transação", async () => {
    await service.importMatches(seasonId, "brasileirao-a", [league("1", "Flamengo", "Palmeiras", 1, day(10))]);
    const before = await rows();

    const down: ResultSource = {
      id: "espn",
      fetchMatches: async () => {
        throw new Error("ESPN respondeu 500");
      },
      fetchStandings: async () => [],
    };
    await expect(service.importFromSource(down, seasonId, "brasileirao-a", 2027)).rejects.toThrow(/ESPN respondeu 500/);
    expect(await rows()).toEqual(before);

    let openTransactions = -1;
    const probing: ResultSource = {
      id: "espn",
      fetchMatches: async () => {
        const res = await database.conn.pool.query(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'",
        );
        openTransactions = res.rows[0].n;
        return [league("1", "Flamengo", "Palmeiras", 1, day(10), { status: "finished", homeGoals: 1, awayGoals: 0 })];
      },
      fetchStandings: async () => [],
    };
    const report = await service.importFromSource(probing, seasonId, "brasileirao-a", 2027);
    expect(openTransactions).toBe(0);
    expect(report).toMatchObject({ updated: 1 });
  });

  it("a rodada da fonte para pontos corridos e a fase para copas são gravadas como vieram", async () => {
    await service.importMatches(seasonId, "copa-do-brasil", [
      league("c1", "Flamengo", "Palmeiras", 1, day(10), {
        competition: "copa-do-brasil",
        round: null,
        phase: "oitavas",
        status: "finished",
        homeGoals: 1,
        awayGoals: 1,
        advancedName: "Palmeiras",
      }),
    ]);
    const [row] = await rows();
    expect(row).toMatchObject({ competition: "copa-do-brasil", round: null, phase: "oitavas", advancedClubId: clubIds.get("PAL3") });
  });
});
