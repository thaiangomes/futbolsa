import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { EntryService } from "../../src/modules/entry/enter.service.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { countingDatabase, type CountingDatabase } from "../support/counting-db.js";
import { useTestDatabase } from "../support/db.js";
import { T0 } from "../support/fixtures.js";
import { entryWorld } from "./support.js";

/** O orçamento da trava: no máximo 24 comandos SQL entre o `FOR UPDATE` dos clubes e o `COMMIT`, qualquer que seja o número de clubes. */
const BUDGET = 24;

/** Quantos comandos cada combinação (modo:clubes) mandou com os clubes travados. */
const COUNTS = new Map<string, number>();

/** Os comandos da transação de entrada a partir da trava dos clubes (inclusive), até o `commit` (inclusive). */
function lockedWindow(statements: readonly string[]): string[] {
  const lock = statements.findIndex((s) => /for update/i.test(s) && /season_clubs/.test(s));
  expect(lock).toBeGreaterThan(-1);
  const commit = statements.findIndex((s, i) => i > lock && /^\s*commit\s*$/i.test(s));
  expect(commit).toBeGreaterThan(lock);
  return statements.slice(lock, commit + 1);
}

describe.each([20, 22, 24])("orçamento da trava com %i clubes", (clubs) => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(T0);
  let counting: CountingDatabase;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await entryWorld(database.db, { clubs });
    counting = countingDatabase(database.conn.pool);
    app = await createTestApp({ db: counting.db, clock });
  });
  afterAll(() => app?.close());

  it.each(["index", "cash"] as const)("modo %s: até 24 comandos com os clubes travados", async (mode) => {
    const account = await createAccount(database.db);
    const mark = counting.mark();
    await app.get(EntryService).enter({ type: "user", userId: account.id, status: "active" }, mode);
    const locked = lockedWindow(counting.since(mark));
    expect(locked.length, locked.join("\n")).toBeLessThanOrEqual(BUDGET);
    // laço de `post` seria uns 5 comandos por clube: o `postMany` mantém a conta fixa
    expect(locked.length).toBeLessThan(clubs * 2);
    COUNTS.set(`${mode}:${clubs}`, locked.length);
  });
});

describe("a contagem não depende do número de clubes", () => {
  it.each(["index", "cash"] as const)("modo %s: a mesma quantidade de comandos com 20, 22 e 24 clubes", (mode) => {
    const counts = [20, 22, 24].map((clubs) => COUNTS.get(`${mode}:${clubs}`));
    expect(counts.every((c) => c !== undefined)).toBe(true);
    expect(new Set(counts).size).toBe(1);
  });
});
