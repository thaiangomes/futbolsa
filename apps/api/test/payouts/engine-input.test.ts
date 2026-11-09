import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { computeStandings, eventsFor } from "@futbolsa/engine";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { clubs, matches, seasonClubs, standings } from "../../src/infra/db/schema/index.js";
import { toEngineMatch } from "../../src/modules/admin/results/to-engine.js";
import { EngineInputService } from "../../src/modules/admin/payouts/engine-input.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, seedSeason } from "../support/fixtures.js";

const day = (d: number, hour = 19) => new Date(Date.UTC(2027, 4, d, hour));
const CONFIRMED = new Date("2027-12-10T12:00:00Z");

describe("entrada do motor (EngineInputService)", () => {
  const t = useTestDatabase(6);
  let seasonId: number;
  let ids: Map<string, number>;
  let service: EngineInputService;
  let coritiba: number;
  let goias: number;
  let outOfWindowId: number;
  let postponedId: number;

  beforeAll(async () => {
    ({ seasonId, clubIds: ids } = await seedSeason(t.db));
    const values = new SeasonValuesService(t.db);
    await withTransaction(t.db, (tx) => values.createInitial(tx, seasonId));
    service = new EngineInputService(values);
    await listClubs(t.db, seasonId, ids, ["FLA3", "PAL3", "COR3", "BOT3"]);
    await t.db.insert(seasonClubs).values({ seasonId, clubId: ids.get("SPT3")!, division: "B", lastPrice: 2000 });
    // clubes da Série B que não estão listados (sem ticker)
    [{ id: coritiba }, { id: goias }] = (await t.db
      .insert(clubs)
      .values([{ name: "Coritiba" }, { name: "Goiás" }])
      .returning({ id: clubs.id })) as [{ id: number }, { id: number }];

    const a = (round: number, home: string, away: string, hg: number, ag: number, d: number, extra = {}) => ({
      seasonId,
      competition: "brasileirao-a",
      round,
      homeClubId: ids.get(home)!,
      awayClubId: ids.get(away)!,
      kickoff: day(d),
      finishedAt: day(d, 21),
      homeGoals: hg,
      awayGoals: ag,
      status: "finished",
      ...extra,
    });
    const b = (round: number, home: number, away: number, hg: number, ag: number, d: number) => ({
      seasonId,
      competition: "brasileirao-b",
      round,
      homeClubId: home,
      awayClubId: away,
      kickoff: day(d),
      finishedAt: day(d, 21),
      homeGoals: hg,
      awayGoals: ag,
      status: "finished",
    });
    const spt = ids.get("SPT3")!;
    const rows = await t.db
      .insert(matches)
      .values([
        // Série A: pelos pontos, PAL3 e COR3 (6) na frente de BOT3 e FLA3 (0)
        a(1, "FLA3", "PAL3", 0, 2, 1),
        a(1, "COR3", "BOT3", 1, 0, 1),
        a(2, "PAL3", "BOT3", 3, 0, 8),
        // fora da janela da rodada: vira adiado no motor, mas foi disputado
        a(2, "FLA3", "COR3", 0, 1, 12, { outOfWindow: true }),
        b(1, spt, coritiba, 1, 1, 2),
        b(2, goias, spt, 0, 0, 9),
        b(3, coritiba, goias, 2, 0, 16),
        // copa: adiado ainda sem data nova, contra clube que não está listado (VAS3)
        {
          seasonId,
          competition: "copa-do-brasil",
          phase: "3a-fase",
          homeClubId: ids.get("FLA3")!,
          awayClubId: ids.get("VAS3")!,
          kickoff: day(20),
          status: "postponed",
        },
      ])
      .returning({ id: matches.id, outOfWindow: matches.outOfWindow, status: matches.status });
    outOfWindowId = rows.find((r) => r.outOfWindow)!.id;
    postponedId = rows.find((r) => r.status === "postponed")!.id;

    // classificação oficial importada, contra os pontos e o saldo (e gravada fora de ordem)
    const row = (competition: string, clubId: number, position: number, points: number, confirmedAt: Date | null = CONFIRMED) => ({
      seasonId,
      competition,
      clubId,
      position,
      points,
      confirmedAt,
    });
    await t.db.insert(standings).values([
      row("brasileirao-a", ids.get("PAL3")!, 3, 6),
      row("brasileirao-a", ids.get("FLA3")!, 1, 0),
      row("brasileirao-a", ids.get("COR3")!, 4, 6),
      row("brasileirao-a", ids.get("BOT3")!, 2, 0),
      row("brasileirao-b", spt, 2, 2),
      row("brasileirao-b", goias, 3, 1, null),
      row("brasileirao-b", coritiba, 1, 4),
    ]);
  });

  it("div 8: a ordem da classificação oficial importada vale, mesmo contra pontos e saldo", async () => {
    const loaded = await service.load(t.db, seasonId);
    expect(loaded.input.standings).toEqual({
      "brasileirao-a": ["FLA3", "BOT3", "PAL3", "COR3"],
      "brasileirao-b": [`EXT-${coritiba}`, "SPT3", `EXT-${goias}`],
    });
    // a tabela calculada pelos pontos daria outra ordem
    const computed = computeStandings(loaded.input.matches.filter((m) => m.competition === "brasileirao-a")).map((r) => r.clubId);
    expect(computed.slice(0, 2)).toEqual(expect.arrayContaining(["PAL3", "COR3"]));

    const { events } = eventsFor(loaded.input);
    const placement = events.filter((e) => e.kind === "placement").map((e) => [e.clubId, e.perShare, e.reason]);
    expect(placement).toEqual(
      expect.arrayContaining([
        ["FLA3", 500, "1º lugar"],
        ["BOT3", 450, "2º lugar"],
        ["PAL3", 400, "3º lugar"],
        ["COR3", 350, "4º lugar"],
      ]),
    );
    expect(placement).toHaveLength(4);
    // na Série B o Coritiba (1º, não listado) não recebe; o SPT3 (2º) recebe o acesso
    const promotion = events.filter((e) => e.kind === "promotion").map((e) => [e.clubId, e.perShare]);
    expect(promotion).toEqual([["SPT3", 200]]);
    expect(events.every((e) => !e.clubId.startsWith("EXT-"))).toBe(true);
  });

  it("os jogos saem como o toEngineMatch converte: adiado e fora da janela viram postponed", async () => {
    const loaded = await service.load(t.db, seasonId);
    const rows = await t.db.select().from(matches).where(eq(matches.seasonId, seasonId));
    expect(loaded.input.matches).toHaveLength(rows.length);
    const expected = rows.map((r) => toEngineMatch(r, loaded.tickerOf));
    expect([...loaded.input.matches].sort((x, y) => Number(x.id) - Number(y.id))).toEqual(
      expected.sort((x, y) => Number(x.id) - Number(y.id)),
    );
    const outOfWindow = loaded.input.matches.find((m) => m.id === String(outOfWindowId))!;
    expect(outOfWindow).toMatchObject({ status: "finished", postponed: true, home: "FLA3", away: "COR3" });
    const postponed = loaded.input.matches.find((m) => m.id === String(postponedId))!;
    expect(postponed).toMatchObject({ status: "scheduled", postponed: true, away: "VAS3" });
    const bMatch = loaded.input.matches.find((m) => m.competition === "brasileirao-b" && m.round === 1)!;
    expect(bMatch.away).toBe(`EXT-${coritiba}`);
  });

  it("clubes não listados ficam fora de listed; os valores são os da temporada", async () => {
    const loaded = await service.load(t.db, seasonId);
    expect([...loaded.input.listed].sort()).toEqual(["BOT3", "COR3", "FLA3", "PAL3", "SPT3"]);
    expect(loaded.input.listed.has("VAS3")).toBe(false);
    expect(loaded.input.listed.has(`EXT-${coritiba}`)).toBe(false);
    const values = await withTransaction(t.db, (tx) => new SeasonValuesService(t.db).loadSeasonValues(tx, seasonId));
    expect(loaded.input.values).toEqual(values);
  });

  it("converte o clubId do motor (ticker ou EXT-) em clubs.id e de volta", async () => {
    const loaded = await service.load(t.db, seasonId);
    expect(loaded.clubIdOf("FLA3")).toBe(ids.get("FLA3"));
    expect(loaded.clubIdOf(`EXT-${coritiba}`)).toBe(coritiba);
    expect(loaded.tickerOf(ids.get("SPT3")!)).toBe("SPT3");
    expect(loaded.tickerOf(goias)).toBe(`EXT-${goias}`);
    expect(() => loaded.clubIdOf("ZZZ3")).toThrow(/ZZZ3/);
    expect(() => loaded.clubIdOf("EXT-999999")).toThrow(/EXT-999999/);
  });

  it("diz se cada tabela oficial está conferida (todas as linhas com confirmedAt)", async () => {
    const loaded = await service.load(t.db, seasonId);
    expect(loaded.standingsConfirmed("brasileirao-a")).toBe(true);
    expect(loaded.standingsConfirmed("brasileirao-b")).toBe(false);
    // competição sem tabela importada não está conferida
    expect(loaded.standingsConfirmed("copa-do-brasil")).toBe(false);
  });

  it("sem tabela importada a competição fica fora de standings, e a colocação não gera evento", async () => {
    await t.db.delete(standings).where(eq(standings.competition, "brasileirao-a"));
    try {
      const loaded = await service.load(t.db, seasonId);
      expect(Object.keys(loaded.input.standings)).toEqual(["brasileirao-b"]);
      expect(loaded.standingsConfirmed("brasileirao-a")).toBe(false);
      expect(eventsFor(loaded.input).events.filter((e) => e.kind === "placement")).toEqual([]);
    } finally {
      const pos: Record<string, [number, number]> = { FLA3: [1, 0], BOT3: [2, 0], PAL3: [3, 6], COR3: [4, 6] };
      await t.db.insert(standings).values(
        Object.entries(pos).map(([ticker, [position, points]]) => ({
          seasonId,
          competition: "brasileirao-a",
          clubId: ids.get(ticker)!,
          position,
          points,
          confirmedAt: CONFIRMED,
        })),
      );
    }
  });

  it("aceita o banco, a transação do Drizzle ou o Tx, com o mesmo resultado", async () => {
    const direct = (await service.load(t.db, seasonId)).input;
    const inTx = await withTransaction(t.db, async (tx) => (await service.load(tx, seasonId)).input);
    const inDrizzle = await withTransaction(t.db, async (tx) => (await service.load(tx.db, seasonId)).input);
    expect(inTx).toEqual(direct);
    expect(inDrizzle).toEqual(direct);
  });
});
