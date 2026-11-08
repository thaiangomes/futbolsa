import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { BRASILEIRAO_A, BRASILEIRAO_B, COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { cupPhases, seasonCups, seasonRules, seasons } from "../../src/infra/db/schema/index.js";
import { createAccount } from "../support/accounts.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { cupFromRows, cupToRows } from "../../src/modules/dividends/season-values/mapper.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

const INITIAL = {
  leagues: { "brasileirao-a": BRASILEIRAO_A, "brasileirao-b": BRASILEIRAO_B },
  cups: { "copa-do-brasil": COPA_DO_BRASIL, libertadores: LIBERTADORES, sulamericana: SULAMERICANA },
};

describe("valores da temporada (dividends)", () => {
  const database = useTestDatabase(6);
  const clock = new FixedClock(new Date("2027-05-20T15:00:00Z"));
  let service: SeasonValuesService;
  let seasonId: number;

  beforeAll(async () => {
    service = new SeasonValuesService(database.db);
    ({ seasonId } = await seedSeason(database.db));
  });

  const load = (id: number) => withTransaction(database.db, (tx) => service.loadSeasonValues(tx, id));

  it("dividendos 28: os valores iniciais gravados e relidos são iguais às constantes do motor", async () => {
    await withTransaction(database.db, (tx) => service.createInitial(tx, seasonId));
    expect(await load(seasonId)).toEqual(INITIAL);
  });

  it("criar os valores de novo não muda nada (a temporada já tem os dela)", async () => {
    await database.db.update(seasonRules).set({ aPerPoint: 11 }).where(eq(seasonRules.seasonId, seasonId));
    const created = await withTransaction(database.db, (tx) => service.createInitial(tx, seasonId));
    expect(created).toBe(false);
    expect((await load(seasonId)).leagues["brasileirao-a"]!.perPoint).toBe(11);
    await database.db.update(seasonRules).set({ aPerPoint: 10 }).where(eq(seasonRules.seasonId, seasonId));
  });

  it("a cópia da temporada anterior preserva as mudanças dela, mas não a confirmação das copas", async () => {
    await database.db.update(seasonRules).set({ aPerPoint: 12, promotionPerShare: 250 }).where(eq(seasonRules.seasonId, seasonId));
    await database.db
      .update(cupPhases)
      .set({ perShare: 90 })
      .where(and(eq(cupPhases.seasonId, seasonId), eq(cupPhases.competition, "copa-do-brasil"), eq(cupPhases.phaseKey, "oitavas")));
    await database.db.insert(seasonCups).values({ seasonId, competition: "copa-do-brasil", confirmedAt: clock.now() }).onConflictDoUpdate({
      target: [seasonCups.seasonId, seasonCups.competition],
      set: { confirmedAt: clock.now() },
    });
    const [next] = await database.db.insert(seasons).values({ year: 2028 }).returning({ id: seasons.id });
    await withTransaction(database.db, (tx) => service.createInitial(tx, next!.id));
    const copied = await load(next!.id);
    expect(copied.leagues["brasileirao-a"]!.perPoint).toBe(12);
    expect(copied.leagues["brasileirao-b"]!.placement).toEqual([250, 250, 250, 250]);
    expect(copied.cups["copa-do-brasil"]!.advance["oitavas"]).toBe(90);
    const cups = await database.db.select().from(seasonCups).where(eq(seasonCups.seasonId, next!.id));
    expect(cups.map((c) => c.competition).sort()).toEqual(["copa-do-brasil", "libertadores", "sulamericana"]);
    expect(cups.every((c) => c.confirmedAt === null)).toBe(true);
    // a temporada anterior não mudou
    expect((await load(seasonId)).cups["copa-do-brasil"]!.advance["oitavas"]).toBe(90);
  });

  it("dividendos 28: abrir o IPO sem a tabela de alguma copa confirmada é recusado (assertCupsConfirmed)", async () => {
    const [s] = await database.db.insert(seasons).values({ year: 2029 }).returning({ id: seasons.id });
    await withTransaction(database.db, (tx) => service.createInitial(tx, s!.id));
    await expect(service.assertCupsConfirmed(s!.id)).rejects.toMatchObject({ code: "cups_not_confirmed", status: 409 });
    const admin = await createAccount(database.db, { role: "admin" });
    for (const competition of ["copa-do-brasil", "libertadores"] as const) {
      await database.db
        .update(seasonCups)
        .set({ confirmedBy: admin.id, confirmedAt: clock.now() })
        .where(and(eq(seasonCups.seasonId, s!.id), eq(seasonCups.competition, competition)));
    }
    await expect(service.assertCupsConfirmed(s!.id)).rejects.toMatchObject({ code: "cups_not_confirmed" });
    await database.db
      .update(seasonCups)
      .set({ confirmedBy: admin.id, confirmedAt: clock.now() })
      .where(and(eq(seasonCups.seasonId, s!.id), eq(seasonCups.competition, "sulamericana")));
    await expect(service.assertCupsConfirmed(s!.id)).resolves.toBeUndefined();
  });

  it("dividendos 28: com o IPO aberto, mudar a tabela é recusado pelo serviço e pelo banco", async () => {
    const [s] = await database.db.insert(seasons).values({ year: 2030 }).returning({ id: seasons.id });
    await withTransaction(database.db, (tx) => service.createInitial(tx, s!.id));
    await expect(withTransaction(database.db, (tx) => service.assertEditable(tx, s!.id))).resolves.toBeUndefined();

    const openedAt = new Date("2030-03-01T12:00:00Z");
    await withTransaction(database.db, (tx) => service.lockSeasonValues(tx, s!.id, openedAt));
    const [rules] = await database.db.select().from(seasonRules).where(eq(seasonRules.seasonId, s!.id));
    expect(rules!.lockedAt).toEqual(openedAt);

    // pelo serviço
    await expect(withTransaction(database.db, (tx) => service.assertEditable(tx, s!.id))).rejects.toMatchObject({
      code: "season_locked",
      status: 409,
    });
    // pelo banco, com SQL direto
    await expect(database.db.update(seasonRules).set({ aPerPoint: 99 }).where(eq(seasonRules.seasonId, s!.id))).rejects.toThrow();
    await expect(
      database.db.insert(cupPhases).values({ seasonId: s!.id, competition: "libertadores", phaseKey: "x", variant: "advance", ord: 99, perShare: 1 }),
    ).rejects.toThrow();
    await expect(database.db.delete(cupPhases).where(eq(cupPhases.seasonId, s!.id))).rejects.toThrow();
    // travar de novo é inofensivo e não muda a hora
    await withTransaction(database.db, (tx) => service.lockSeasonValues(tx, s!.id, new Date("2030-04-01T00:00:00Z")));
    const [again] = await database.db.select().from(seasonRules).where(eq(seasonRules.seasonId, s!.id));
    expect(again!.lockedAt).toEqual(openedAt);
  });

  it("os valores de uma temporada que não existe voltam como erro", async () => {
    await expect(load(987_654)).rejects.toThrow(/sem valores/);
  });
});

describe("conversão das copas entre o banco e o motor", () => {
  it("ida e volta de cada copa do motor, inclusive os caminhos da Sul-Americana", () => {
    for (const cup of [COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA]) {
      expect(cupFromRows(cupToRows(cup))).toEqual(cup);
    }
  });

  it("a Copa do Brasil de 2026 com nove fases é montada nas linhas e relida na ordem", () => {
    const nove = {
      phases: ["1a-fase", "2a-fase", "3a-fase", "4a-fase", "5a-fase", "oitavas", "quartas", "semifinal", "final"],
      advance: { "1a-fase": 50, "2a-fase": 60, "3a-fase": 75, "4a-fase": 90, "5a-fase": 100, oitavas: 150, quartas: 250, semifinal: 400 },
      title: 800,
    };
    const rows = cupToRows(nove);
    expect(rows.map((r) => r.ord)).toEqual([...rows.map((r) => r.ord)].sort((a, b) => a - b));
    expect(cupFromRows(rows)).toEqual(nove);
  });
});
