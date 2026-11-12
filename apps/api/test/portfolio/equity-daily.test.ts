import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { equityResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { equityDaily, seasons, wallets } from "../../src/infra/db/schema/index.js";
import { EquityDailyService } from "../../src/modules/portfolio/daily/equity-daily.service.js";
import { brasiliaDay, closedDays } from "../../src/modules/portfolio/daily/days.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { AFTER_OPEN, applyMovements, creditPayout, insertPayout, ipoBuy, portfolioSeason, setPrice, type PortfolioSeason } from "./support.js";

// T9: patrimônio diário (Carteira e gráficos 29 e 44).

const at = (iso: string) => new Date(iso);

describe("dias de Brasília", () => {
  it("o dia fecha às 24h de Brasília, com 5 minutos de folga", () => {
    expect(brasiliaDay(at("2027-04-06T02:59:59Z").getTime())).toBe("2027-04-05");
    expect(brasiliaDay(at("2027-04-06T03:00:00Z").getTime())).toBe("2027-04-06");
    // 2027-04-06T03:00:00Z é o fim do dia 5; com a folga, só às 03:05:00
    expect(closedDays(at("2027-04-05T13:00:00Z").getTime(), at("2027-04-06T03:04:59Z").getTime())).toEqual([]);
    expect(closedDays(at("2027-04-05T13:00:00Z").getTime(), at("2027-04-06T03:05:00Z").getTime()).map((d) => brasiliaDay(d))).toEqual(["2027-04-05"]);
  });
});

describe("EquityDailyService e GET /portfolio/equity", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let fla: number;
  let ana: { account: Awaited<ReturnType<typeof createAccount>>; wallet: number };
  let service: EquityDailyService;

  const rowsOf = (walletId: number) =>
    database.db.select({ day: equityDaily.day, equity: equityDaily.equity }).from(equityDaily).where(eq(equityDaily.walletId, walletId)).orderBy(asc(equityDaily.day));

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    service = app.get(EquityDailyService);
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    ana = { account, wallet: wallet! };
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 100, 4000));
    await setPrice(database.db, s, "FLA3", at("2027-04-06T13:00:00Z"), 4400);
  });
  afterAll(async () => {
    await app.close();
  });

  it("carteira 29: com a API fora por vários dias, ao voltar grava todos os dias que faltam com os valores de cada dia", async () => {
    const report = await service.runOnce(at("2027-04-08T12:00:00Z"));
    expect(report.days).toEqual(["2027-04-01", "2027-04-02", "2027-04-03", "2027-04-04", "2027-04-05", "2027-04-06", "2027-04-07"]);
    const rows = await rowsOf(ana.wallet);
    expect(rows.map((r) => r.day)).toEqual(report.days);
    // R$ 100.000,00 até a compra; o preço sobe a R$ 44,00 no dia 6 (100 ações: +R$ 400,00)
    expect(rows.map((r) => r.equity)).toEqual([10_000_000, 10_000_000, 10_000_000, 10_000_000, 10_000_000, 10_040_000, 10_040_000]);
  });

  it("gravar de novo não duplica, e duas execuções ao mesmo tempo (duas instâncias) também não", async () => {
    expect((await service.runOnce(at("2027-04-08T12:00:00Z"))).written).toBe(0);
    const other = new EquityDailyService(database.db, clock);
    await Promise.all([service.runOnce(at("2027-04-09T12:00:00Z")), other.runOnce(at("2027-04-09T12:00:00Z"))]);
    const rows = await rowsOf(ana.wallet);
    expect(rows.map((r) => r.day).at(-1)).toBe("2027-04-08");
    expect(new Set(rows.map((r) => r.day)).size).toBe(rows.length);
  });

  it("a tesouraria fica fora, o dia da entrada conta e quem entra depois só tem os dias a partir da entrada", async () => {
    const [treasury] = await database.db.select().from(wallets).where(and(eq(wallets.seasonId, s.seasonId), eq(wallets.ownerType, "treasury")));
    expect(treasury).toBeUndefined();
    await openWallets(database.db, s.seasonId, [{ type: "treasury" }]);
    const late = await createAccount(database.db);
    const [lateWallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: late.id }]);
    await database.db.update(wallets).set({ enteredAt: at("2027-04-08T12:00:00Z") }).where(eq(wallets.id, lateWallet!));
    await service.runOnce(at("2027-04-10T12:00:00Z"));
    expect((await rowsOf(lateWallet!)).map((r) => r.day)).toEqual(["2027-04-08", "2027-04-09"]);
    const [t] = await database.db.select().from(wallets).where(and(eq(wallets.seasonId, s.seasonId), eq(wallets.ownerType, "treasury")));
    expect(await rowsOf(t!.id)).toEqual([]);
  });

  it("carteira 44: uma correção de pagamento não muda os dias já gravados; o valor atual reflete", async () => {
    const before = await rowsOf(ana.wallet);
    const eventId = await insertPayout(database.db, { seasonId: s.seasonId, clubId: fla }, { key: "pts-44", perShare: 30, closedAt: at("2027-04-06T12:00:00Z"), status: "approved", holdings: [[ana.wallet, 100]] });
    await creditPayout(database.db, eventId, ana.wallet, fla, at("2027-04-06T13:00:00Z"), 3000);
    await service.runOnce(at("2027-04-10T12:00:00Z"));
    expect(await rowsOf(ana.wallet)).toEqual(before);

    const res = await app.inject({ method: "GET", url: "/portfolio/equity", headers: bearer(await ana.account.tokenWith({ at: clock.now() })) });
    expect(res.statusCode).toBe(200);
    const body = equityResponseSchema.parse(res.json());
    expect(body.base).toBe(10_000_000);
    expect(body.points.map((p) => p.day).slice(0, 3)).toEqual(["2027-04-01", "2027-04-02", "2027-04-03"]);
    expect(body.points).toEqual(before.concat([]).slice(0, body.points.length));
    expect(body.current.equity).toBe(10_000_000 + 40_000 + 3000);
    expect(body.dividendDays).toEqual([{ day: "2027-04-06", total: 3000 }]);
    expect(body.startedAt).toBe("2027-04-01T13:00:00.000Z");
  });

  it("temporada encerrada ou em preparação: nada a gravar", async () => {
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, s.seasonId));
    expect((await service.runOnce(at("2027-05-01T12:00:00Z"))).written).toBe(0);
    await database.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, s.seasonId));
  });

  it("sem login dá 401", async () => {
    expect((await app.inject({ method: "GET", url: "/portfolio/equity" })).statusCode).toBe(401);
  });
});
