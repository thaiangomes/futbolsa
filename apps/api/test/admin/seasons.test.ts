import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { publicSeasonSchema, seasonClubsResponseSchema, seasonViewSchema } from "@futbolsa/contracts";
import { ipoDates } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, clubs, seasonClubs, seasonRules, seasons } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

describe("preparar a temporada", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let tickers: string[];

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin" });
    ({ seasonId, clubIds } = await seedSeason(database.db));
    tickers = [...clubIds.keys()];
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await database.db.delete(seasonClubs);
    await database.db.update(seasons).set({ status: "preparing", offerSize: null, firstKickoff: null, ipoOpensAt: null, ipoClosesAt: null, tradingOpensAt: null }).where(eq(seasons.id, seasonId));
  });

  const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object, token = admin.token) =>
    app.inject({ method, url, headers: bearer(token), ...(payload ? { payload } : {}) });

  /** Os 20 clubes na Série A, na ordem do seed (1 a 20). */
  const twenty = () => tickers.slice(0, 20).map((t, i) => ({ clubId: clubIds.get(t)!, division: "A" as const, prevPlacement: i + 1 }));

  it("admin 31: jogador comum não acessa as rotas da temporada", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/seasons/current" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "POST", url: "/admin/seasons", payload: { year: 2040 } });
    await expectAdminOnly(app, database.db, { method: "PATCH", url: `/admin/seasons/${seasonId}`, payload: { offerSize: 1000 } });
    await expectAdminOnly(app, database.db, { method: "PUT", url: `/admin/seasons/${seasonId}/clubs`, payload: { clubs: twenty() } });
  });

  it("GET /season é público e mostra a temporada atual com os motivos de suspensão", async () => {
    await database.db.insert(seasonClubs).values({ seasonId, clubId: clubIds.get("FLA3")!, division: "A", suspendedReason: "estádio interditado" });
    await database.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, seasonId));
    const res = await app.inject({ method: "GET", url: "/season" });
    expect(res.statusCode).toBe(200);
    const body = publicSeasonSchema.parse(res.json());
    expect(body.season).toMatchObject({ id: seasonId, year: 2027, status: "trading", suspendedReason: null });
    expect(body.suspendedClubs).toEqual([{ ticker: "FLA3", reason: "estádio interditado" }]);
  });

  it("só uma temporada fora de closed: criar outra com a atual em andamento é recusado", async () => {
    const res = await call("POST", "/admin/seasons", { year: 2028 });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("season_exists");
    expect(await database.db.select().from(seasons)).toHaveLength(1);
  });

  it("depois de encerrada a anterior, criar a temporada copia os valores da anterior e registra", async () => {
    await call("PATCH", `/admin/seasons/${seasonId}`, { offerSize: 1000 });
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, seasonId));
    const res = await call("POST", "/admin/seasons", { year: 2028 });
    expect(res.statusCode).toBe(201);
    const created = seasonViewSchema.parse(res.json());
    expect(created).toMatchObject({ year: 2028, status: "preparing", offerSize: null });
    const [rules] = await database.db.select().from(seasonRules).where(eq(seasonRules.seasonId, created.id));
    expect(rules).toMatchObject({ aPerPoint: 10, promotionSlots: 4, lockedAt: null });
    const [log] = (await database.db.select().from(adminLog).where(eq(adminLog.action, "season.create"))).slice(-1);
    expect(log).toMatchObject({ actorId: admin.id, targetType: "season", targetId: String(created.id) });
    expect((await call("POST", "/admin/seasons", { year: 2029 })).statusCode).toBe(409);
    // ano repetido ou anterior é recusado com 400, não com erro do banco
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, created.id));
    const repeated = await call("POST", "/admin/seasons", { year: 2028 });
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json()).toMatchObject({ code: "invalid_input", fields: ["year"] });
    expect((await call("POST", "/admin/seasons", { year: 2026 })).statusCode).toBe(400);
    await database.db.update(seasons).set({ status: "preparing" }).where(eq(seasons.id, created.id));
    // a temporada de 2028 sai do caminho dos outros testes
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, created.id));
  });

  it("o tamanho da oferta e a data do primeiro jogo calculam as datas do IPO", async () => {
    const firstKickoff = "2027-04-03T21:00:00Z";
    const res = await call("PATCH", `/admin/seasons/${seasonId}`, { offerSize: 5000, firstKickoff });
    expect(res.statusCode).toBe(200);
    const dates = ipoDates(Date.parse(firstKickoff));
    expect(seasonViewSchema.parse(res.json())).toMatchObject({
      offerSize: 5000,
      firstKickoff: "2027-04-03T21:00:00.000Z",
      ipoOpensAt: new Date(dates.opensAt).toISOString(),
      ipoClosesAt: new Date(dates.closesAt).toISOString(),
      tradingOpensAt: new Date(dates.tradingOpensAt).toISOString(),
    });
    const [log] = (await database.db.select().from(adminLog).where(eq(adminLog.action, "season.update"))).slice(-1);
    expect(log).toMatchObject({ before: { offerSize: null, firstKickoff: null }, after: { offerSize: 5000 } });
  });

  it("ipo 7: com as ofertas abertas, mudar o tamanho da oferta é recusado", async () => {
    await call("PATCH", `/admin/seasons/${seasonId}`, { offerSize: 5000 });
    await database.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, seasonId));
    for (const body of [{ offerSize: 6000 }, { firstKickoff: "2027-05-01T21:00:00Z" }]) {
      const res = await call("PATCH", `/admin/seasons/${seasonId}`, body);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ipo_opened");
    }
    const clubsRes = await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: twenty() });
    expect(clubsRes.statusCode).toBe(409);
    const [season] = await database.db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(season!.offerSize).toBe(5000);
  });

  it("temporada que não existe volta 404", async () => {
    expect((await call("PATCH", "/admin/seasons/999999", { offerSize: 10 })).statusCode).toBe(404);
    expect((await call("PUT", "/admin/seasons/999999/clubs", { clubs: twenty() })).statusCode).toBe(404);
  });

  it("confirma a lista de clubes com divisão e colocação anterior numa ordem única de 1 a 24", async () => {
    const list = twenty();
    // os 4 promovidos da Série B entram na Série A com 21 a 24 e saem do 17º ao 20º; aqui, um caso simples
    const res = await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: list });
    expect(res.statusCode).toBe(200);
    const body = seasonClubsResponseSchema.parse(res.json());
    expect(body.clubs).toHaveLength(20);
    expect(body.clubs[0]).toMatchObject({ division: "A", prevPlacement: 1, club: { ticker: "FLA3" } });
    expect(await database.db.select().from(seasonClubs)).toHaveLength(20);
    const [log] = (await database.db.select().from(adminLog).where(eq(adminLog.action, "season.clubs.update"))).slice(-1);
    expect(log!.after).toMatchObject({ clubs: expect.any(Array) });
    // GET /admin/seasons/current mostra o que foi confirmado
    const current = (await call("GET", "/admin/seasons/current")).json();
    expect(current.clubs).toHaveLength(20);
    expect(current.season.id).toBe(seasonId);
  });

  it("confirmar de novo troca a lista inteira (clube que saiu deixa de estar listado)", async () => {
    await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: twenty() });
    const [other] = await database.db.insert(clubs).values({ ticker: "NOV3", name: "Novo" }).returning();
    const next = twenty().slice(0, 19);
    next.push({ clubId: other!.id, division: "A", prevPlacement: 24 });
    const res = await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: next });
    expect(res.statusCode).toBe(200);
    const listed = await database.db.select().from(seasonClubs);
    expect(listed).toHaveLength(20);
    expect(listed.some((c) => c.clubId === other!.id)).toBe(true);
    await database.db.delete(seasonClubs);
    await database.db.delete(clubs).where(eq(clubs.id, other!.id));
  });

  it("os 20 clubes da Série A são exigidos, sem repetir", async () => {
    const list = twenty();
    const nineteen = await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: list.slice(0, 19) });
    expect(nineteen.statusCode).toBe(400);
    const twentyOneInA = [...list.slice(0, 19), { ...list[19]!, division: "B" as const, prevPlacement: null }];
    const oneInB = await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: twentyOneInA });
    expect(oneInB.statusCode).toBe(400);
    expect(oneInB.json()).toMatchObject({ code: "invalid_input", fields: ["clubs"] });
    const repeated = [...list.slice(0, 19), { ...list[0]!, prevPlacement: 20 }];
    expect((await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: repeated })).statusCode).toBe(400);
    expect(await database.db.select().from(seasonClubs)).toHaveLength(0);
  });

  it("clube sem ticker é recusado; a colocação anterior não repete e a Série B fica sem ela", async () => {
    const [unlisted] = await database.db.insert(clubs).values({ name: "Sem Ticker FC" }).returning();
    const list = twenty();
    const withoutTicker = [...list.slice(0, 19), { clubId: unlisted!.id, division: "A" as const, prevPlacement: 20 }];
    const res = await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: withoutTicker });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_input", fields: ["clubs"] });

    const sameSpot = list.map((c, i) => (i === 19 ? { ...c, prevPlacement: 1 } : c));
    expect((await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: sameSpot })).statusCode).toBe(400);

    const [extra] = await database.db.insert(clubs).values({ ticker: "EXB3", name: "Extra B" }).returning();
    const bWithPlacement = [...list, { clubId: extra!.id, division: "B" as const, prevPlacement: 3 }];
    expect((await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: bWithPlacement })).statusCode).toBe(400);
    const bWithout = [...list, { clubId: extra!.id, division: "B" as const, prevPlacement: null }];
    expect((await call("PUT", `/admin/seasons/${seasonId}/clubs`, { clubs: bWithout })).statusCode).toBe(200);
    await database.db.delete(seasonClubs);
    await database.db.delete(clubs).where(eq(clubs.id, unlisted!.id));
    await database.db.delete(clubs).where(eq(clubs.id, extra!.id));
  });
});
