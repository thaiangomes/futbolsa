import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enterResultSchema, entryPreviewSchema, errorResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasons } from "../../src/infra/db/schema/index.js";
import { EventBus, meChannel, type BusEvent } from "../../src/infra/realtime/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { T0 } from "../support/fixtures.js";
import { entryWorld, type EntryWorld } from "./support.js";

describe("rotas da entrada no meio da temporada", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(T0);
  let app: NestFastifyApplication;
  let world: EntryWorld;

  beforeAll(async () => {
    world = await entryWorld(database.db, { clubs: 20 });
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
  });
  afterAll(() => app?.close());

  const call = async (account: TestAccount, method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(await account.tokenWith({ at: clock.now() })), payload });

  it("sem login as duas rotas respondem 401", async () => {
    expect((await app.inject({ method: "GET", url: "/entry/preview" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/entry", payload: { mode: "index" } })).statusCode).toBe(401);
  });

  it("entrada 9: a prévia sem carteira está aberta, com a carteira índice marcada, e bate com o contrato", async () => {
    const account = await createAccount(database.db);
    const res = await call(account, "GET", "/entry/preview");
    expect(res.statusCode).toBe(200);
    const body = entryPreviewSchema.parse(res.json());
    expect(body).toMatchObject({ availability: "open", defaultMode: "index" });
    // 20 clubes a R$ 24,00 = R$ 480,00 → ⌊70.000 ÷ 480⌋ = 145
    expect(body.quote).toMatchObject({ n: 145, sum: 48_000, clubCount: 20 });
  });

  it("entrada 1: POST /entry 201 com o resultado final; repetir dá 200 com repeated; outro modo dá 409", async () => {
    const account = await createAccount(database.db);
    const bus = app.get(EventBus);
    const seen: BusEvent[] = [];
    const sub = bus.subscribe(meChannel(account.id), (event) => seen.push(event));
    const first = await call(account, "POST", "/entry", { mode: "index" });
    expect(first.statusCode).toBe(201);
    const result = enterResultSchema.parse(first.json());
    expect(result).toMatchObject({ mode: "index", n: 145, sum: 48_000, repeated: false });
    expect(result.cash).toBe(10_000_000 - 145 * 48_000);
    // depois do COMMIT o dono recebe wallet.changed e entry.added (a linha `initial` e uma por clube)
    expect(seen.filter((e) => e.frame.includes("\"wallet.changed\""))).toHaveLength(21);
    expect(seen.filter((e) => e.frame.includes("\"entry.added\""))).toHaveLength(21);
    sub.unsubscribe();

    const again = await call(account, "POST", "/entry", { mode: "index" });
    expect(again.statusCode).toBe(200);
    expect(enterResultSchema.parse(again.json())).toEqual({ ...result, repeated: true });

    const other = await call(account, "POST", "/entry", { mode: "cash" });
    expect(other.statusCode).toBe(409);
    expect(errorResponseSchema.parse(other.json())).toMatchObject({ code: "already_entered" });

    const preview = entryPreviewSchema.parse((await call(account, "GET", "/entry/preview")).json());
    expect(preview).toMatchObject({ availability: "already_entered", mode: "index" });
  });

  it("corpo inválido: 400 invalid_input; só caixa responde 201 sem ações", async () => {
    const account = await createAccount(database.db);
    for (const payload of [{ mode: "tudo" }, {}, { mode: "index", extra: 1 }]) {
      const res = await call(account, "POST", "/entry", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "invalid_input" });
    }
    const cash = await call(account, "POST", "/entry", { mode: "cash" });
    expect(cash.statusCode).toBe(201);
    expect(enterResultSchema.parse(cash.json())).toMatchObject({ mode: "cash", n: 0, cash: 10_000_000, clubs: [] });
  });

  it("estados que recusam: janela fechada e mercado suspenso (409), conta bloqueada (403)", async () => {
    const account = await createAccount(database.db);
    await database.db.update(seasons).set({ suspendedReason: "preço errado" }).where(eq(seasons.id, world.seasonId));
    const suspended = await call(account, "POST", "/entry", { mode: "index" });
    expect(suspended.statusCode).toBe(409);
    expect(suspended.json()).toMatchObject({ code: "market_suspended" });
    expect(suspended.json().message).toContain("preço errado");
    expect(entryPreviewSchema.parse((await call(account, "GET", "/entry/preview")).json()).availability).toBe("market_suspended");
    await database.db.update(seasons).set({ suspendedReason: null, status: "trading_ended" }).where(eq(seasons.id, world.seasonId));
    expect((await call(account, "POST", "/entry", { mode: "index" })).json()).toMatchObject({ code: "entry_window_closed" });
    await database.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, world.seasonId));

    const blocked = await createAccount(database.db, { status: "blocked" });
    const res = await call(blocked, "POST", "/entry", { mode: "index" });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("limite de uso: a 6ª confirmação no minuto recebe 429", async () => {
    const account = await createAccount(database.db);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(account, "POST", "/entry", { mode: "index" })).statusCode);
    expect(statuses.slice(0, 5)).toEqual([201, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});
