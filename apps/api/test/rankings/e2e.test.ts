import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { officialRankingSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasons } from "../../src/infra/db/schema/index.js";
import { ApproveService } from "../../src/modules/admin/payouts/approve.service.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { closeAtOfMonth } from "../../src/modules/rankings/base.js";
import { RankingsPortAdapter } from "../../src/modules/rankings/recalc.service.js";
import { RankingsService } from "../../src/modules/rankings/rankings.service.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { useTestDatabase } from "../support/db.js";
import { applyMovements, br, inTx, insertPayout, ipoBuy, player, portfolioSeason, setCash, type PortfolioSeason } from "./support.js";

// T11: de ponta a ponta com a F12: aprovar um pagamento de um mês já fechado refaz o ranking e a rota mostra a versão 2.

describe("aprovar um pagamento refaz o ranking fechado", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(br("2027-07-01 09:00"));
  let app: NestFastifyApplication;
  let s: PortfolioSeason;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock });
    s = await portfolioSeason(database.db);
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, s.seasonId));
  });
  afterAll(async () => {
    await app.close();
  });

  it("a F12 usa a porta da F13, o pedido de recálculo é gravado e atendido, e a rota mostra Bruno em 1º na versão 2", async () => {
    expect(app.get(RankingsPort)).toBeInstanceOf(RankingsPortAdapter);
    const cor = s.clubIds.get("COR3")!;
    const fla = s.clubIds.get("FLA3")!;
    const admin = await createAccount(database.db, { role: "admin" });
    const ana = await player(database.db, s.seasonId, { nickname: "ana_e2e" });
    const bruno = await player(database.db, s.seasonId, { nickname: "bruno_e2e" });
    await applyMovements(database.db, bruno.wallet, br("2027-04-05 11:00"), ipoBuy(cor, 1000, 4000));
    await setCash(database.db, ana.wallet, br("2027-06-10 12:00"), 10_800_000, fla);
    const rankings = app.get(RankingsService);
    await inTx(database.db, (tx) => rankings.closeMonth(tx, { seasonId: s.seasonId, monthKey: "2027-06", at: closeAtOfMonth("2027-06") }));
    const before = officialRankingSchema.parse((await app.inject({ method: "GET", url: "/rankings/month/2027-06?limit=100" })).json());
    expect(before.rows.find((r) => r.displayName === "ana_e2e")!.position).toBe(1);
    expect(before.version).toBe(1);

    // a rodada 18 fechou às 20h de 30/06 e o evento só nasce em 01/07 (valor de R$ 50,00 por ação, Bruno com 1.000 ações)
    const ev = await insertPayout(database.db, { seasonId: s.seasonId, clubId: cor }, { key: "r18-e2e", perShare: 5000, closedAt: br("2027-06-30 20:00"), holdings: [[bruno.wallet, 1000]] });
    const res = await app.get(ApproveService).approve(admin.id, { eventIds: [ev] });
    expect(res.results[0]!.outcome).toBe("approved");

    // o `wake()` roda depois do COMMIT, sem segurar a aprovação: espera o pedido ser atendido
    for (let i = 0; i < 100 && (await inTx(database.db, (tx) => rankings.pendingRecalc(tx, s.seasonId))); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await inTx(database.db, (tx) => rankings.pendingRecalc(tx, s.seasonId))).toBe(false);

    const after = officialRankingSchema.parse((await app.inject({ method: "GET", url: "/rankings/month/2027-06?limit=100" })).json());
    expect(after.version).toBe(2);
    expect(after.rows.find((r) => r.displayName === "bruno_e2e")!.position).toBe(1);
    expect(after.rows.find((r) => r.displayName === "ana_e2e")!.position).toBe(2);
    const history = (await app.inject({ method: "GET", url: "/rankings/history" })).json() as { seasons: Array<{ months: Array<{ monthKey: string; version: number; champions: Array<{ displayName: string }> }> }> };
    const june = history.seasons[0]!.months.find((m) => m.monthKey === "2027-06")!;
    expect(june.version).toBe(2);
    expect(june.champions[0]!.displayName).toBe("bruno_e2e");
  });
});
