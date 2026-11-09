import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { SchedulerRegistry } from "@nestjs/schedule";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipoDates } from "@futbolsa/engine";
import { Clock, FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { ipoBids, ipoResults, seasonClubs, seasonCups, seasons, wallets } from "../../src/infra/db/schema/index.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import {
  IpoBidsService,
  IpoClosingService,
  IpoJob,
  IpoOpeningService,
  IpoSettlementService,
  type IpoJobReport,
} from "../../src/modules/ipo/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

const MINUTE = 60_000;
const SERIE_A = [
  "PAL3", "FLU3", "FLA3", "VAS3", "BOT3", "COR3", "SAO3", "SAN3", "GRE3", "INT3",
  "CRU3", "CAM3", "BAH3", "FOR3", "CEA3", "SPT3", "JUV3", "VIT3", "MIR3", "RBB3",
] as const;
const PLACEMENTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 21, 22, 23, 24];
/** Primeiro jogo em 2027-04-11 às 16h de Brasília. */
const DATES = ipoDates(new Date("2027-04-11T19:00:00Z").getTime());

describe("tarefa agendada do IPO", () => {
  const database = useTestDatabase(20);
  const clock = new FixedClock(new Date(DATES.opensAt - 10 * MINUTE));
  let app: NestFastifyApplication;
  let job: IpoJob;
  let seasonId: number;
  let clubIds: Map<string, number>;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    job = app.get(IpoJob);
    const values = app.get(SeasonValuesService, { strict: false });
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    const admin = await createAccount(database.db, { role: "admin", nickname: "chefe_job" });
    await withTransaction(database.db, (tx) => values.createInitial(tx, seasonId));
    await database.db.update(seasonCups).set({ confirmedAt: new Date("2027-03-01T12:00:00Z"), confirmedBy: admin.id }).where(eq(seasonCups.seasonId, seasonId));
    await database.db
      .update(seasons)
      .set({
        offerSize: 1000,
        firstKickoff: new Date("2027-04-11T19:00:00Z"),
        ipoOpensAt: new Date(DATES.opensAt),
        ipoClosesAt: new Date(DATES.closesAt),
        tradingOpensAt: new Date(DATES.tradingOpensAt),
      })
      .where(eq(seasons.id, seasonId));
    await database.db.insert(seasonClubs).values(
      SERIE_A.map((ticker, i) => ({ seasonId, clubId: clubIds.get(ticker)!, division: "A", prevPlacement: PLACEMENTS[i]! })),
    );
  });
  afterAll(() => app?.close());

  const status = async () => (await database.db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!.status;
  const resultCount = async () =>
    (await database.db.select({ n: sql<number>`count(*)::int` }).from(ipoResults).where(eq(ipoResults.seasonId, seasonId)))[0]!.n;

  it("admin 19 e ipo 1: só o relógio avançando abre, fecha e liquida, sem nenhuma chamada do admin", async () => {
    const account = await createAccount(database.db, { nickname: "ana_job", at: new Date(DATES.opensAt - 5 * MINUTE) });

    // antes da abertura: nada acontece
    let report = await job.runOnce();
    expect(report).toMatchObject({ skipped: false, opening: { status: "idle" }, closing: { status: "idle" }, settlement: { status: "idle" } });
    expect(await status()).toBe("preparing");

    // na abertura
    clock.set(new Date(DATES.opensAt));
    report = await job.runOnce();
    expect(report).toMatchObject({ skipped: false, opening: { status: "opened" } });
    expect(await status()).toBe("ipo_open");
    const [wallet] = await database.db.select().from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, account.id)));
    expect(wallet!.cash).toBe(INITIAL_CASH);

    // uma oferta no FLA3, pelo mesmo serviço que as rotas usam
    clock.set(new Date(DATES.opensAt + 60 * MINUTE));
    await app.get(IpoBidsService).place(wallet!.id, "FLA3", { quantity: 100, maxPrice: 4000, expect: "new" });
    expect((await database.db.select().from(ipoBids))).toHaveLength(1);

    // um minuto antes do fechamento: nada
    clock.set(new Date(DATES.closesAt - MINUTE));
    report = await job.runOnce();
    expect(report).toMatchObject({ closing: { status: "idle" }, settlement: { status: "idle" } });

    // no fechamento a mesma passada fecha e liquida os 20 clubes
    clock.set(new Date(DATES.closesAt));
    report = (await job.runOnce()) as Exclude<IpoJobReport, { skipped: true }>;
    expect(report).toMatchObject({ closing: { status: "closed" }, settlement: { status: "ran", pending: 0 } });
    expect(await status()).toBe("ipo_closed");
    expect(await resultCount()).toBe(20);

    // passada seguinte: tudo igual
    const again = await job.runOnce();
    expect(again).toMatchObject({ opening: { status: "idle" }, closing: { status: "idle" }, settlement: { status: "ran", settled: [], pending: 0 } });
    expect(await resultCount()).toBe(20);
    await assertLedgerConsistent(database.db, seasonId);
    await assertSharesConserved(database.db, seasonId);
  });

  it("nunca duas passadas ao mesmo tempo na mesma instância: a segunda chamada é pulada", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const slow = new IpoJob(
      new SchedulerRegistry(),
      app.get(Clock),
      { openIfDue: async () => { calls++; await gate; return { status: "idle" }; } } as unknown as IpoOpeningService,
      { closeIfDue: async () => ({ status: "idle" }) } as unknown as IpoClosingService,
      { settleDue: async () => ({ status: "idle" }) } as unknown as IpoSettlementService,
    );
    const first = slow.runOnce();
    expect(await slow.runOnce()).toEqual({ skipped: true });
    release();
    expect(await first).toMatchObject({ skipped: false });
    expect(calls).toBe(1);
    // terminada a primeira, uma nova passada roda
    expect(await slow.runOnce()).toMatchObject({ skipped: false });
  });

  it("erro numa etapa não impede as outras nem a passada seguinte", async () => {
    const calls: string[] = [];
    let fail = true;
    const flaky = new IpoJob(
      new SchedulerRegistry(),
      app.get(Clock),
      { openIfDue: async () => { calls.push("abrir"); if (fail) throw new Error("falha ao abrir"); return { status: "idle" }; } } as unknown as IpoOpeningService,
      { closeIfDue: async () => { calls.push("fechar"); return { status: "idle" }; } } as unknown as IpoClosingService,
      { settleDue: async () => { calls.push("liquidar"); return { status: "idle" }; } } as unknown as IpoSettlementService,
    );
    const first = (await flaky.runOnce()) as Exclude<IpoJobReport, { skipped: true }>;
    expect(calls).toEqual(["abrir", "fechar", "liquidar"]);
    expect(first.opening).toMatchObject({ status: "error", error: "falha ao abrir" });
    expect(first.closing).toEqual({ status: "idle" });

    fail = false;
    calls.length = 0;
    const second = (await flaky.runOnce()) as Exclude<IpoJobReport, { skipped: true }>;
    expect(calls).toEqual(["abrir", "fechar", "liquidar"]);
    expect(second.opening).toEqual({ status: "idle" });
  });

  it("com a API fora entre o fechamento e a liquidação, a primeira passada depois faz as duas coisas", async () => {
    // Uma temporada nova: abre, passa do fechamento sem ninguém rodar a tarefa e só então roda.
    await database.db.update(seasons).set({ status: "closed" }).where(ne(seasons.id, -1));
    const { seasonId: next, clubIds: ids } = await seedSeason(database.db, 2028);
    const values = app.get(SeasonValuesService, { strict: false });
    await withTransaction(database.db, (tx) => values.createInitial(tx, next));
    const admin = await createAccount(database.db, { role: "admin", nickname: "chefe_job2" });
    await database.db.update(seasonCups).set({ confirmedAt: new Date("2028-03-01T12:00:00Z"), confirmedBy: admin.id }).where(eq(seasonCups.seasonId, next));
    const dates = ipoDates(new Date("2028-04-09T19:00:00Z").getTime());
    await database.db
      .update(seasons)
      .set({ offerSize: 500, firstKickoff: new Date("2028-04-09T19:00:00Z"), ipoOpensAt: new Date(dates.opensAt), ipoClosesAt: new Date(dates.closesAt), tradingOpensAt: new Date(dates.tradingOpensAt) })
      .where(eq(seasons.id, next));
    await database.db.insert(seasonClubs).values(
      SERIE_A.map((ticker, i) => ({ seasonId: next, clubId: ids.get(ticker)!, division: "A", prevPlacement: PLACEMENTS[i]! })),
    );

    clock.set(new Date(dates.opensAt));
    expect(await job.runOnce()).toMatchObject({ opening: { status: "opened" } });
    // a API "fica fora" até depois do fechamento
    clock.set(new Date(dates.closesAt + 30 * MINUTE));
    const report = await job.runOnce();
    expect(report).toMatchObject({ closing: { status: "closed" }, settlement: { status: "ran", pending: 0 } });
    const [row] = await database.db.select().from(seasons).where(eq(seasons.id, next));
    expect(row!.status).toBe("ipo_closed");
    expect(
      (await database.db.select({ n: sql<number>`count(*)::int` }).from(ipoResults).where(eq(ipoResults.seasonId, next)))[0]!.n,
    ).toBe(20);
    await assertLedgerConsistent(database.db, next);
  });
});
