import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { clubs, cupPhases, seasonClubs, seasonCups, seasonRules, walletEntries } from "../../src/infra/db/schema/index.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openPlayerWallets, seedSeason, T0 } from "../support/fixtures.js";

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? String(error);
  }
  throw new Error("era para o banco recusar");
}

const RULES = {
  aPerPoint: 10,
  bPerPoint: 5,
  aPlacement: [500, 450, 400],
  promotionPerShare: 200,
  promotionSlots: 4,
};

describe("T3: restrições que o Drizzle não gera (migração 0001)", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let clubIds: Map<string, number>;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await seedSeason(t.db));
    await listClubs(t.db, seasonId, clubIds, ["FLA3"]);
  });

  it("o extrato e os negócios são histórico: mudar ou apagar uma linha falha", async () => {
    const [walletId] = await openPlayerWallets(t.db, seasonId, 1);
    const [entry] = await t.db.select().from(walletEntries).where(eq(walletEntries.walletId, walletId!));
    expect(await errorMessage(t.db.update(walletEntries).set({ cashDelta: 1 }).where(eq(walletEntries.id, entry!.id)))).toMatch(
      /history_immutable/,
    );
    expect(await errorMessage(t.db.delete(walletEntries).where(eq(walletEntries.id, entry!.id)))).toMatch(/history_immutable/);
    for (const table of ["trades", "payout_holdings", "payout_credits", "admin_log", "ranking_rows"]) {
      expect(await errorMessage(t.db.execute(sql.raw(`delete from futbolsa.${table}`))), table).toMatch(/history_immutable/);
    }
  });

  it("valores da temporada mudam antes da trava e não depois (dividendos 21)", async () => {
    await t.db.insert(seasonRules).values({ seasonId, ...RULES });
    await t.db.insert(cupPhases).values({ seasonId, competition: "copa-do-brasil", phaseKey: "oitavas", ord: 4, perShare: 150 });
    await t.db.insert(seasonCups).values({ seasonId, competition: "copa-do-brasil" });
    // antes da trava, tudo muda
    await t.db.update(cupPhases).set({ perShare: 160 }).where(eq(cupPhases.seasonId, seasonId));
    // a abertura do IPO grava o locked_at
    await t.db.update(seasonRules).set({ lockedAt: T0 }).where(eq(seasonRules.seasonId, seasonId));

    expect(await errorMessage(t.db.update(cupPhases).set({ perShare: 170 }).where(eq(cupPhases.seasonId, seasonId)))).toMatch(
      /season_values_locked/,
    );
    expect(
      await errorMessage(
        t.db.insert(cupPhases).values({ seasonId, competition: "copa-do-brasil", phaseKey: "quartas", ord: 5, perShare: 250 }),
      ),
    ).toMatch(/season_values_locked/);
    expect(await errorMessage(t.db.delete(seasonCups).where(eq(seasonCups.seasonId, seasonId)))).toMatch(/season_values_locked/);
    expect(await errorMessage(t.db.update(seasonRules).set({ aPerPoint: 20 }).where(eq(seasonRules.seasonId, seasonId)))).toMatch(
      /season_values_locked/,
    );
    // tirar a trava também é recusado
    expect(await errorMessage(t.db.update(seasonRules).set({ lockedAt: null }).where(eq(seasonRules.seasonId, seasonId)))).toMatch(
      /season_values_locked/,
    );
    const [phase] = await t.db.select().from(cupPhases).where(eq(cupPhases.seasonId, seasonId));
    expect(phase!.perShare).toBe(160);
  });

  it("clube listado na temporada precisa de ticker", async () => {
    const [unlisted] = await t.db.insert(clubs).values({ name: "Clube sem ticker da Série B" }).returning();
    expect(await errorMessage(t.db.insert(seasonClubs).values({ seasonId, clubId: unlisted!.id, division: "B" }))).toMatch(
      /club_without_ticker/,
    );
  });
});
