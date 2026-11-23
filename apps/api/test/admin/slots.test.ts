import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { adminLog } from "../../src/infra/db/schema/index.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

describe("regras de vaga da temporada", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let values: SeasonValuesService;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin", nickname: "chefe" });
    ({ seasonId } = await seedSeason(database.db));
    values = app.get(SeasonValuesService, { strict: false });
  });
  afterAll(() => app.close());

  const call = (method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(admin.token), ...(payload ? { payload } : {}) });
  const logs = (action: string) => database.db.select().from(adminLog).where(eq(adminLog.action, action));

  it("regras de vaga: o admin monta antes do IPO e depois só corrige, com motivo e no registro", async () => {
    await call("GET", `/admin/seasons/${seasonId}/rules`);
    const url = `/admin/seasons/${seasonId}/slots`;
    const slots = {
      destinations: [
        { destination: "libertadores", tableSlots: 5, routes: [{ cup: "copa-do-brasil", result: "champion" }, { cup: "copa-do-brasil", result: "runnerUp" }, { cup: "libertadores", result: "champion" }] },
        { destination: "sulamericana", tableSlots: 6, routes: [] },
      ],
    };
    const motivo = "Vagas de 2027 conforme o regulamento publicado.";
    expect((await call("GET", url)).json()).toEqual({ slots: null, locked: false });
    // sem motivo e com destino repetido não passa
    expect((await call("PUT", url, { slots })).statusCode).toBe(400);
    expect((await call("PUT", url, { slots: { destinations: [slots.destinations[0], slots.destinations[0]] }, reason: motivo })).statusCode).toBe(400);
    const primeiro = await call("PUT", url, { slots, reason: motivo });
    expect(primeiro.statusCode, primeiro.body).toBe(200);
    expect((await call("GET", url)).json()).toEqual({ slots, locked: false });
    // antes do IPO não há o que corrigir
    expect((await call("POST", `${url}/correction`, { slots, reason: motivo })).json().code).toBe("rules_correction_not_needed");

    await withTransaction(database.db, (tx) => values.lockSeasonValues(tx, seasonId, clock.now()));
    // depois do IPO a tela normal recusa e só a correção muda
    const res = await call("PUT", url, { slots, reason: motivo });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("season_locked");
    const nova = { destinations: [{ ...slots.destinations[0], tableSlots: 6 }, slots.destinations[1]] };
    expect((await call("POST", `${url}/correction`, { slots: nova, reason: motivo })).statusCode).toBe(200);
    expect((await call("GET", url)).json()).toEqual({ slots: nova, locked: true });
    const [registro] = await logs("season.slots.correct");
    expect(registro).toMatchObject({ actorId: admin.id, targetType: "season", reason: motivo });
    expect((registro!.before as { slots: { destinations: { tableSlots: number }[] } }).slots.destinations[0]!.tableSlots).toBe(5);
    expect((registro!.after as { slots: { destinations: { tableSlots: number }[] } }).slots.destinations[0]!.tableSlots).toBe(6);
  });

  it("regras de vaga são só do admin", async () => {
    await expectAdminOnly(app, database.db, { method: "PUT", url: `/admin/seasons/${seasonId}/slots`, payload: { slots: { destinations: [] }, reason: "x" } });
  });
});
