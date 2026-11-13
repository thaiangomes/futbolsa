import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { officialRankingSchema, rankingHistorySchema, type OfficialRanking } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasons } from "../../src/infra/db/schema/index.js";
import { closeAtOfMonth } from "../../src/modules/rankings/base.js";
import { RankingsService } from "../../src/modules/rankings/rankings.service.js";
import { createTestApp } from "../support/app.js";
import { useTestDatabase } from "../support/db.js";
import { bot, br, inTx, player, portfolioSeason, setBotsInRankings, setCash, setStatus, type PortfolioSeason } from "./support.js";

// T8: leituras oficiais e índice (Rankings mensal e anual 6, 7, 8, 15, 18, 19 e 21; privacidade, P7).

describe("rotas dos rankings oficiais", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(br("2027-12-20 12:00"));
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let rankings: RankingsService;
  let fla: number;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock });
    rankings = app.get(RankingsService);
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, s.seasonId));
  });
  afterAll(async () => {
    await app.close();
  });

  const closeMonth = (key: string) => inTx(database.db, (tx) => rankings.closeMonth(tx, { seasonId: s.seasonId, monthKey: key, at: closeAtOfMonth(key) }));
  const get = async (url: string) => {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, body: res.json(), raw: res.body };
  };

  it("rankings 6, 15, 18, 19 e 21 e privacidade: ordem e empates, bot marcado, conta excluída, 409 do ano em curso, índice com campeões", async () => {
    const ana = await player(database.db, s.seasonId, { nickname: "ana_off" });
    const carla = await player(database.db, s.seasonId, { nickname: "carla_off" });
    const davi = await player(database.db, s.seasonId, { nickname: "davi_off" });
    const robo = await bot(database.db, s.seasonId, "dividendos");
    await setBotsInRankings(database.db, s.seasonId, true);
    await setCash(database.db, ana.wallet, br("2027-05-10 12:00"), 11_000_000, fla);
    await setCash(database.db, carla.wallet, br("2027-05-10 12:00"), 10_500_000, fla);
    await setCash(database.db, robo.wallet, br("2027-05-10 12:00"), 10_500_000, fla);
    await setCash(database.db, davi.wallet, br("2027-05-10 12:00"), 10_200_000, fla);
    await closeMonth("2027-05");
    // Davi exclui a conta em junho: o oficial de maio continua com ele, como "conta excluída"
    await setStatus(database.db, davi.account.id, "deleted");
    await database.db.execute((await import("drizzle-orm")).sql`update futbolsa.users set nickname = null, email = null where id = ${davi.account.id}`);
    await setBotsInRankings(database.db, s.seasonId, false); // 8: desligar não muda o oficial de maio

    const may = officialRankingSchema.parse((await get("/rankings/month/2027-05?limit=100")).body) as OfficialRanking;
    expect(may.botsIncluded).toBe(true);
    const mine = ["ana_off", "carla_off"].map((n) => may.rows.find((r) => r.displayName === n)!.position);
    expect(mine[0]).toBeLessThan(mine[1]!);
    const robot = may.rows.find((r) => r.isBot)!;
    expect(robot).toMatchObject({ botLabel: "Bot dividendos", displayName: null });
    expect(robot.position).toBe(may.rows.find((r) => r.displayName === "carla_off")!.position); // 15: empate divide a posição
    const excluded = may.rows.filter((r) => r.displayName === null && !r.isBot);
    expect(excluded).toHaveLength(1);
    expect(JSON.stringify(may)).not.toContain("davi_off");

    // privacidade: nada de patrimônio, base, e-mail, id de usuário ou de carteira
    const raw = (await get("/rankings/month/2027-05?limit=100")).raw;
    expect(raw).not.toMatch(/equity|base"|email|userId|walletId/);
    expect(raw).not.toContain(String(ana.account.id));
    expect(may.rows.every((r) => /^[A-Za-z0-9_-]{16}$/.test(r.walletKey))).toBe(true);

    // 19: o ano em curso responde 409
    expect((await get("/rankings/season/2027")).status).toBe(409);
    expect((await get("/rankings/season/2027")).body.code).toBe("season_not_closed");
    expect((await get("/rankings/month/2027-09")).status).toBe(404);
    expect((await get("/rankings/month/2027-13")).body.code).toBe("invalid_period");
    expect((await get("/rankings/season/27")).body.code).toBe("invalid_period");

    // 21: encerrada, o índice mostra os meses e o anual com os campeões
    await database.db.update(seasons).set({ tradingEndedAt: br("2027-12-10 18:00") }).where(eq(seasons.id, s.seasonId));
    await inTx(database.db, (tx) => rankings.closeSeason(tx, { seasonId: s.seasonId, at: br("2027-12-10 18:00") }));
    const year = officialRankingSchema.parse((await get("/rankings/season/2027")).body);
    expect(year.periodKey).toBe("2027");
    const history = rankingHistorySchema.parse((await get("/rankings/history")).body);
    const y2027 = history.seasons.find((x) => x.year === 2027)!;
    expect(y2027.months.map((m) => m.monthKey)).toEqual(["2027-05", "2027-12"]);
    expect(y2027.season!.champions.length).toBeGreaterThan(0);
    expect(y2027.months[0]!.champions[0]!.displayName).toBe("ana_off");
    expect(JSON.stringify(history)).not.toContain("davi_off");
  });

  it("um recálculo não muda o conjunto do oficial: quem não estava no ranking de maio continua fora", async () => {
    // um pedido de recálculo sem mudança não cria versão; forçamos uma mudança movendo o caixa de alguém
    const bruno = await player(database.db, s.seasonId, { nickname: "bruno_off", enteredAt: br("2027-04-02 10:00") });
    await setCash(database.db, bruno.wallet, br("2027-05-20 12:00"), 12_000_000, fla); // antes do fechamento de maio, mas Bruno não estava no oficial
    await inTx(database.db, (tx) => rankings.requestRecalc(tx, { seasonId: s.seasonId, from: br("2027-05-31 23:00"), reason: "teste" }));
    await database.db.update(seasons).set({ status: "trading_ended" }).where(eq(seasons.id, s.seasonId));
    await rankings.processRecalcRequests(br("2027-12-21 12:00"));
    const may = officialRankingSchema.parse((await get("/rankings/month/2027-05?limit=100")).body);
    expect(may.version).toBe(1); // o conjunto de maio não muda: Bruno não aparece e nada mudou
    expect(may.rows.some((r) => r.displayName === "bruno_off")).toBe(false);
  });
});
