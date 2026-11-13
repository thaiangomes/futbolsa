import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { matches, seasonClubs } from "../../src/infra/db/schema/index.js";
import { EventBus, type BusEvent } from "../../src/infra/realtime/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, seedSeason } from "../support/fixtures.js";

const HOUR = 3_600_000;

describe("eventos de tempo real do admin", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let bus: EventBus;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    bus = app.get(EventBus, { strict: false });
    admin = await createAccount(database.db, { role: "admin" });
    ({ seasonId, clubIds } = await seedSeason(database.db));
    await listClubs(database.db, seasonId, clubIds, [...clubIds.keys()]);
  });
  afterAll(() => app.close());

  const call = (method: "POST" | "DELETE" | "PATCH", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(admin.token), ...(payload ? { payload } : {}) });
  const frames = (events: BusEvent[]) => events.map((e) => JSON.parse(e.frame));

  it("admin 23: suspender e retomar avisam todos no canal season, só depois do COMMIT, com o motivo", async () => {
    const live: BusEvent[] = [];
    let reasonSeenInDb: string | null | undefined;
    bus.subscribe("season", (e) => {
      live.push(e);
      // o evento só sai depois do COMMIT: o banco já tem o motivo
      void database.db
        .select()
        .from(seasonClubs)
        .then((rows) => {
          reasonSeenInDb = rows.find((r) => r.clubId === clubIds.get("FLA3"))?.suspendedReason;
        });
    });
    await call("POST", "/admin/suspensions", { ticker: "FLA3", reason: "estádio interditado" });
    await call("DELETE", "/admin/suspensions/FLA3");
    const f = frames(live);
    expect(f.map((x) => x.type)).toEqual(["market.suspended", "market.resumed"]);
    expect(f[0].data).toEqual({ scope: "club", ticker: "FLA3", reason: "estádio interditado" });
    expect(f[1].data).toEqual({ scope: "club", ticker: "FLA3" });
    expect(live[1]!.seq).toBe(live[0]!.seq + 1);
    expect(reasonSeenInDb).toBeDefined();
  });

  it("suspensão recusada não publica evento nenhum", async () => {
    const live: BusEvent[] = [];
    bus.subscribe("season", (e) => live.push(e));
    await call("POST", "/admin/suspensions", { ticker: "ZZZ3", reason: "clube que não existe" });
    await call("POST", "/admin/suspensions", { ticker: "FLA3" });
    await call("DELETE", "/admin/suspensions/PAL3");
    expect(live).toEqual([]);
  });

  it("o mercado todo suspenso avisa com scope market", async () => {
    const live: BusEvent[] = [];
    bus.subscribe("season", (e) => live.push(e));
    await call("POST", "/admin/suspensions", { reason: "falha na fonte dos placares" });
    await call("DELETE", "/admin/suspensions");
    expect(frames(live).map((x) => x.data)).toEqual([
      { scope: "market", ticker: null, reason: "falha na fonte dos placares" },
      { scope: "market", ticker: null },
    ]);
  });

  it("admin 5: no canal admin, o aviso de pendência sai quando o jogo muda, só se o número mudou", async () => {
    const live: BusEvent[] = [];
    bus.subscribe("admin", (e) => live.push(e));
    const [m] = await database.db
      .insert(matches)
      .values({
        seasonId,
        competition: "brasileirao-a",
        round: 2,
        homeClubId: clubIds.get("FLA3")!,
        awayClubId: clubIds.get("PAL3")!,
        kickoff: new Date(clock.now().getTime() - 12 * HOUR),
        source: "t",
        sourceId: "ev-1",
      })
      .returning();
    const events = app.get(await import("../../src/modules/admin/events.js").then((x) => x.AdminEvents), { strict: false });
    await events.publishPending();
    await events.publishPending();
    expect(frames(live).map((x) => x.data)).toEqual([{ pendingMatches: 1, pendingPayouts: 0, openFraudCases: 0 }]);
    // marcar o jogo como adiado pela rota publica o novo número
    await call("PATCH", `/admin/matches/${m!.id}`, { status: "postponed", reason: "adiado pela federação" });
    await new Promise((r) => setTimeout(r, 100));
    expect(frames(live).map((x) => x.data)).toEqual([{ pendingMatches: 1, pendingPayouts: 0, openFraudCases: 0 }, { pendingMatches: 0, pendingPayouts: 0, openFraudCases: 0 }]);
  });
});
