import "reflect-metadata";

import { describe, expect, it } from "vitest";
import { meResponseSchema } from "@futbolsa/contracts";
import { createAccount } from "../support/accounts.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { createTestApp } from "../support/app.js";
import { T0 } from "../support/fixtures.js";
import { useTestDatabase } from "../support/db.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { afterAll, beforeAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { openWallets } from "../support/fixtures.js";
import { closeWindow, entryWorld, reopenWindow, type EntryWorld } from "./support.js";

describe("needsEntry do GET /me vem da janela da entrada", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(T0);
  let app: NestFastifyApplication;
  let world: EntryWorld;
  beforeAll(async () => {
    world = await entryWorld(database.db, { clubs: 20 });
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
  });
  afterAll(() => app?.close());

  const me = async (account: Awaited<ReturnType<typeof createAccount>>) => {
    const res = await app.inject({ method: "GET", url: "/me", headers: bearer(await account.tokenWith({ at: clock.now() })) });
    expect(res.statusCode).toBe(200);
    return meResponseSchema.parse(res.json());
  };

  it("entrada 9: sem carteira e com a janela aberta, needsEntry é verdadeiro", async () => {
    const account = await createAccount(database.db);
    const body = await me(account);
    expect(body).toMatchObject({ registered: true, season: { status: "trading", hasWallet: false, needsEntry: true } });
  });

  it("entrada 12: com a Série A encerrada needsEntry é falso, e volta a ser verdadeiro se o jogo reabre", async () => {
    const account = await createAccount(database.db);
    await closeWindow(database.db, world.seasonId);
    clock.set(new Date("2027-12-03T12:00:00Z"));
    expect(await me(account)).toMatchObject({ season: { needsEntry: false, hasWallet: false } });
    await reopenWindow(database.db, world.seasonId);
    expect(await me(account)).toMatchObject({ season: { needsEntry: true } });
    clock.set(T0);
  });

  it("quem já tem carteira não precisa entrar", async () => {
    const account = await createAccount(database.db);
    await openWallets(database.db, world.seasonId, [{ type: "user", userId: account.id }]);
    expect(await me(account)).toMatchObject({ season: { hasWallet: true, needsEntry: false } });
  });
});
