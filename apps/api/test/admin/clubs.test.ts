import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { knownClubsResponseSchema } from "@futbolsa/contracts";
import { CLUBS } from "@futbolsa/engine/data/clubs";
import { FixedClock } from "../../src/infra/clock/index.js";
import { clubs } from "../../src/infra/db/schema/index.js";
import { createAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

describe("clubes conhecidos", () => {
  const database = useTestDatabase(4);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    await seedSeason(database.db);
  });
  afterAll(() => app.close());

  it("admin 31: só o admin lista os clubes", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/clubs" }, { okStatus: 200 });
  });

  it("lista só os clubes com ticker, em ordem de ticker (clube não listado não entra na escolha da temporada)", async () => {
    await database.db.insert(clubs).values({ name: "Sem Ticker FC" });
    const admin = await createAccount(database.db, { role: "admin" });
    const res = await app.inject({ method: "GET", url: "/admin/clubs", headers: bearer(admin.token) });
    expect(res.statusCode).toBe(200);
    const body = knownClubsResponseSchema.parse(res.json());
    // F17: com os promovidos de 2026 a lista de clubes conhecidos passou de 20 para 24
    expect(body.clubs).toHaveLength(CLUBS.length);
    expect(body.clubs.every((c) => c.ticker !== null)).toBe(true);
    const tickers = body.clubs.map((c) => c.ticker!);
    expect(tickers).toEqual([...tickers].sort());
  });
});
