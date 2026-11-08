import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { overviewSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { matches, seasonClubs, seasonCups, standings } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, seedSeason } from "../support/fixtures.js";

const HOUR = 3_600_000;

describe("visão geral do admin", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin", nickname: "chefe" });
    ({ seasonId, clubIds } = await seedSeason(database.db));
    await listClubs(database.db, seasonId, clubIds, [...clubIds.keys()]);
  });
  afterAll(() => app.close());

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(admin.token), ...(payload ? { payload } : {}) });
  const overview = async () => overviewSchema.parse((await call("GET", "/admin/overview")).json());

  it("admin 31: só o admin vê a visão geral", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/overview" }, { okStatus: 200 });
  });

  it("admin 5: o resumo mostra cada pendência e some quando ela é resolvida", async () => {
    // tudo por fazer: a classificação e as três copas sem conferir
    expect(await overview()).toEqual({
      pendingMatches: 0,
      standingsNotConfirmed: ["brasileirao-a", "brasileirao-b"],
      cupsNotConfirmed: ["copa-do-brasil", "libertadores", "sulamericana"],
      suspendedClubs: [],
      marketSuspended: false,
    });

    // jogo pendente
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
        sourceId: "ov-1",
      })
      .returning();
    expect((await overview()).pendingMatches).toBe(1);
    await call("PATCH", `/admin/matches/${m!.id}`, { status: "postponed", reason: "adiado pela federação" });
    expect((await overview()).pendingMatches).toBe(0);

    // copas
    await call("GET", `/admin/seasons/${seasonId}/rules`);
    for (const c of ["copa-do-brasil", "libertadores", "sulamericana"]) await call("POST", `/admin/seasons/${seasonId}/cups/${c}/confirm`);
    expect((await overview()).cupsNotConfirmed).toEqual([]);
    await database.db.update(seasonCups).set({ confirmedAt: null, confirmedBy: null }).where(eq(seasonCups.competition, "libertadores"));
    expect((await overview()).cupsNotConfirmed).toEqual(["libertadores"]);

    // classificação: com tabela importada e conferida, a competição some da lista
    const rows = [...clubIds.values()].slice(0, 20).map((clubId, i) => ({ seasonId, competition: "brasileirao-a", clubId, position: i + 1, points: 50 - i }));
    await database.db.insert(standings).values(rows);
    expect((await overview()).standingsNotConfirmed).toContain("brasileirao-a");
    await call("POST", "/admin/standings/brasileirao-a/confirm");
    expect((await overview()).standingsNotConfirmed).toEqual(["brasileirao-b"]);

    // suspensão
    await call("POST", "/admin/suspensions", { ticker: "FLA3", reason: "estádio interditado" });
    expect((await overview()).suspendedClubs).toEqual(["FLA3"]);
    await call("POST", "/admin/suspensions", { reason: "falha na fonte dos placares" });
    expect((await overview()).marketSuspended).toBe(true);
    await call("DELETE", "/admin/suspensions");
    await call("DELETE", "/admin/suspensions/FLA3");
    const done = await overview();
    expect(done.marketSuspended).toBe(false);
    expect(done.suspendedClubs).toEqual([]);
    await database.db.update(seasonClubs).set({ suspendedReason: null });
  });
});
