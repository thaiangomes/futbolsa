import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { walletViewSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasons, wallets } from "../../src/infra/db/schema/index.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { createTestApp } from "../support/app.js";
import { tokenFor, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { after, prepareCalls, RecordingRankings, type Season, SilentWaker } from "../payouts/correction-scene.js";
import { at, buybackScene, REGISTERED } from "../admin/buyback-scene.js";

const C = at("2027-12-20T15:00:00Z");
const IPO_2028 = at("2028-03-27T19:00:00Z");

/** A carteira entre temporadas (F15, T8; Conta e login, critérios 16 e 17): 2027 encerrada, 2028 ainda sem IPO. */
describe("carteira entre temporadas (F15, T8)", () => {
  const t = useTestDatabase(20);
  const clock = new FixedClock(REGISTERED);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  const scene = buybackScene(() => t.db, () => app, clock, 2027);
  let s: Season;
  let ana = 0;

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
    });
    await scene.init();
    await t.db.update(seasons).set({ status: "closed", closedAt: at("2026-12-20T15:00:00Z") }).where(ne(seasons.status, "closed"));
    s = await scene.newSeason();
    ana = await scene.player(s);
    await scene.buy(s, ana, "FLA3", 1_000);
    await scene.seasonEnd(s);
    expect((await scene.close(s.seasonId, REGISTERED)).errors).toEqual([]);
    await scene.approveAll(after(REGISTERED, 30));
    const res = await adminCall("POST", `/admin/seasons/${s.seasonId}/close`, { confirmYear: 2027 }, C);
    expect(res.statusCode).toBe(200);
  });
  afterAll(async () => {
    await app?.get(SettleCreditsService, { strict: false }).whenIdle();
    await app?.close();
  });

  async function adminCall(method: "GET" | "POST" | "PATCH", url: string, payload?: object, now: Date = after(C, 60)) {
    clock.set(now);
    const token = await scene.admin.tokenWith({ at: now });
    return app.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${token}` } });
  }
  async function portfolioOf(walletId: number, now: Date) {
    clock.set(now);
    const [w] = await t.db.select().from(wallets).where(eq(wallets.id, walletId));
    const { rows } = await t.db.execute(sql`select subject from futbolsa.auth_identities where user_id = ${w!.userId}`);
    const token = await tokenFor({ subject: String(rows[0]!.subject), at: now });
    return app.inject({ method: "GET", url: "/portfolio", headers: { authorization: `Bearer ${token}` } });
  }

  it("conta 16: com 2027 encerrada e nenhuma temporada preparada, GET /portfolio mostra R$ 0,00, nenhuma ação e o IPO seguinte sem data", async () => {
    const res = await portfolioOf(ana, after(C, 60));
    expect(res.statusCode).toBe(200);
    const view = walletViewSchema.parse(res.json());
    expect(view).toMatchObject({ cash: { total: 0, reserved: 0, free: 0 }, equity: 0, returnBp: 0, positions: [], results: [], between: { closedYear: 2027, nextIpoOpensAt: null } });
  });

  it("conta 16 e 17: com 2028 em preparação, GET /portfolio mostra R$ 0,00, nenhuma ação e a data de abertura do IPO de 2028", async () => {
    const created = await adminCall("POST", "/admin/seasons", { year: 2028 }, after(C, 90));
    expect(created.statusCode).toBe(201);
    const next = created.json().id as number;
    // a data do primeiro jogo marca as datas do IPO
    await t.db.update(seasons).set({ ipoOpensAt: IPO_2028 }).where(eq(seasons.id, next));
    const res = await portfolioOf(ana, after(C, 120));
    expect(res.statusCode).toBe(200);
    const view = walletViewSchema.parse(res.json());
    expect(view).toMatchObject({ cash: { total: 0, reserved: 0, free: 0 }, stocksValue: 0, receivable: 0, equity: 0, positions: [], between: { closedYear: 2027, nextIpoOpensAt: IPO_2028.toISOString() } });

    // quem nunca jogou uma temporada encerrada continua sem carteira (404)
    const res404 = await app.inject({ method: "GET", url: "/portfolio", headers: { authorization: `Bearer ${await scene.admin.tokenWith({ at: after(C, 120) })}` } });
    expect(res404.statusCode).toBe(404);
  });

  it("com o IPO de 2028 aberto, a carteira é a da temporada nova (sem o aviso entre temporadas)", async () => {
    const [next] = await t.db.select().from(seasons).where(eq(seasons.year, 2028));
    await t.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, next!.id));
    const res = await portfolioOf(ana, after(IPO_2028, 10));
    // sem carteira em 2028 (o crédito da F8 não rodou aqui): 404, e não a carteira de 2027
    expect(res.statusCode).toBe(404);
  });
});
