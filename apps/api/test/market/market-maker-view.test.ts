import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marketMakerViewSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { positions, seasonClubs, seasons, wallets } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { insertMatch, marketSeason } from "./helpers.js";
import { giveCash, giveShares, openTreasury } from "./order-helpers.js";

// W6 do Plano do livro de ofertas e formador (prancha 7l): o que o admin vê da tesouraria ao lado dos percentuais.

describe("GET /admin/market-maker: a tesouraria por clube", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin" });
    ({ seasonId, clubIds } = await marketSeason(database.db, { tickers: ["FLA3", "PAL3", "SPT3", "COR3", "CAM3"], totalShares: 3736 }));
    treasury = await openTreasury(database.db, seasonId);
    await giveCash(database.db, treasury, 412_300_00);
  });
  afterAll(() => app.close());

  const view = async () => {
    const res = await app.inject({ method: "GET", url: "/admin/market-maker", headers: bearer(admin.token) });
    expect(res.statusCode).toBe(200);
    return marketMakerViewSchema.parse(res.json());
  };
  const club = (v: Awaited<ReturnType<typeof view>>, ticker: string) => v.treasury!.clubs.find((c) => c.ticker === ticker)!;

  it("devolve o caixa, e por clube o total de ações, as livres da tesouraria e a situação", async () => {
    await giveShares(database.db, treasury, clubIds.get("FLA3")!, 212);
    await giveShares(database.db, treasury, clubIds.get("CAM3")!, 430);
    const v = await view();
    expect(v).toMatchObject({ mmQuantityBp: 25, mmLotBp: 2000 });
    expect(v.treasury).toMatchObject({ cash: 412_300_00, freeCash: 412_300_00 });
    expect(v.treasury!.clubs.map((c) => c.ticker)).toEqual(["CAM3", "COR3", "FLA3", "PAL3", "SPT3"]);
    expect(club(v, "FLA3")).toEqual({ ticker: "FLA3", totalShares: 3736, freeShares: 212, status: "trading", auctionUntil: null });
    expect(club(v, "PAL3")).toMatchObject({ freeShares: 0, status: "trading" });
  });

  it("ações e caixa presos em ordens abertas da casa não contam como livres", async () => {
    await database.db.update(positions).set({ reservedShares: 12 }).where(and(eq(positions.walletId, treasury), eq(positions.clubId, clubIds.get("FLA3")!)));
    await database.db.update(wallets).set({ reservedCash: 300_00 }).where(eq(wallets.id, treasury));
    const v = await view();
    expect(club(v, "FLA3").freeShares).toBe(200);
    expect(v.treasury).toMatchObject({ cash: 412_300_00, freeCash: 412_000_00 });
    await database.db.update(positions).set({ reservedShares: 0 }).where(eq(positions.walletId, treasury));
    await database.db.update(wallets).set({ reservedCash: 0 }).where(eq(wallets.id, treasury));
  });

  it("situação: em jogo, em leilão (com o fim), suspenso pelo clube e suspenso pelo mercado todo", async () => {
    await insertMatch(database.db, { seasonId, homeClubId: clubIds.get("SPT3")!, awayClubId: clubIds.get("COR3")!, kickoff: new Date(clock.now().getTime() - 3_600_000) });
    const until = new Date(clock.now().getTime() + 3_600_000);
    await database.db.update(seasonClubs).set({ auctionOpenedAt: clock.now(), auctionUntil: until }).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubIds.get("PAL3")!)));
    await database.db.update(seasonClubs).set({ suspendedReason: "estádio interditado" }).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubIds.get("CAM3")!)));
    let v = await view();
    expect(club(v, "SPT3").status).toBe("in_match");
    expect(club(v, "COR3").status).toBe("in_match");
    expect(club(v, "PAL3")).toMatchObject({ status: "auction", auctionUntil: until.toISOString() });
    expect(club(v, "CAM3").status).toBe("suspended");
    expect(club(v, "FLA3").status).toBe("trading");

    // o leilão parado pela suspensão (sem fim) continua leilão; suspensão do mercado todo vale para todos os clubes
    await database.db.update(seasonClubs).set({ auctionUntil: null }).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubIds.get("PAL3")!)));
    expect(club(await view(), "PAL3")).toMatchObject({ status: "auction", auctionUntil: null });
    await database.db.update(seasons).set({ suspendedReason: "falha na fonte" }).where(eq(seasons.id, seasonId));
    v = await view();
    expect(v.treasury!.clubs.every((c) => c.status === "suspended")).toBe(true);
    await database.db.update(seasons).set({ suspendedReason: null }).where(eq(seasons.id, seasonId));
  });

  it("jogador recebe 403 e quem não está logado, 401", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/market-maker" });
  });
});
