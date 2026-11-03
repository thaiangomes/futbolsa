import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockSeason, withTransaction } from "../../src/infra/db/index.js";
import { invites, positions, seasonResults, seasons, users, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { AccountsService, SEASON_START_CASH } from "../../src/modules/accounts/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, tokenFor, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent } from "../support/invariants.js";
import { seedSeason } from "../support/fixtures.js";

const IPO_OPENS = new Date("2027-03-28T19:00:00Z"); // 16h de Brasília

describe("R$ 100 mil na abertura das ofertas do IPO", () => {
  const database = useTestDatabase(30);
  const clock = new FixedClock(new Date("2027-03-25T12:00:00Z"));
  let app: NestFastifyApplication;
  let accounts: AccountsService;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    accounts = app.get(AccountsService);
  });
  afterAll(() => app?.close());

  /** O que a F8 faz na tarefa de abertura: trava a temporada, abre o IPO e credita. */
  const openIpo = (seasonId: number, at = IPO_OPENS) =>
    withTransaction(database.db, async (tx) => {
      await lockSeason(tx, seasonId, "update");
      await tx.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, seasonId));
      return accounts.creditSeasonStart(tx, seasonId, at);
    });

  const walletOf = async (seasonId: number, userId: string) =>
    (await database.db.select().from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, userId))))[0];

  it("conta 12: Ana, sem carteira antes, tem R$ 100.000,00 em 2027-03-28 às 16h", async () => {
    const { seasonId } = await seedSeason(database.db, 2027);
    await database.db.update(seasons).set({ ipoOpensAt: IPO_OPENS }).where(eq(seasons.id, seasonId));
    const ana = await createAccount(database.db, { nickname: "anagol" });
    expect(await walletOf(seasonId, ana.id)).toBeUndefined();

    await openIpo(seasonId);
    const wallet = await walletOf(seasonId, ana.id);
    expect(wallet).toMatchObject({ cash: SEASON_START_CASH, reservedCash: 0, entryMode: "ipo", enteredAt: IPO_OPENS });
    const [entry] = await database.db.select().from(walletEntries).where(eq(walletEntries.walletId, wallet!.id));
    expect(entry).toMatchObject({ kind: "initial", cashDelta: 10_000_000, at: IPO_OPENS });
    await assertLedgerConsistent(database.db, seasonId);
  });

  it("conta 17: Bruno, com histórico de 2027, recebe R$ 100.000,00 em 2028, sem ações, com o mesmo apelido", async () => {
    const [s2027] = await database.db.select().from(seasons).where(eq(seasons.year, 2027));
    const bruno = await createAccount(database.db, { nickname: "bruno_hist" });
    await database.db.insert(seasonResults).values({ userId: bruno.id, seasonId: s2027!.id, finalEquity: 16_340_000, base: 10_000_000, position: 2 });
    const { seasonId: s2028 } = await seedSeason(database.db, 2028);

    await openIpo(s2028, new Date("2028-03-26T19:00:00Z"));
    const wallet = await walletOf(s2028, bruno.id);
    expect(wallet!.cash).toBe(10_000_000);
    expect(await database.db.select().from(positions).where(eq(positions.walletId, wallet!.id))).toHaveLength(0);
    const [user] = await database.db.select().from(users).where(eq(users.id, bruno.id));
    expect(user!.nickname).toBe("bruno_hist");
    expect(await database.db.select().from(seasonResults).where(eq(seasonResults.userId, bruno.id))).toHaveLength(1);
  });

  it("conta 18: toda conta ativa ou bloqueada recebe; a excluída não; soma = R$ 100 mil × contas; chamar de novo não muda nada", async () => {
    const { seasonId } = await seedSeason(database.db, 2029);
    const active = await Promise.all([1, 2, 3, 4, 5].map(() => createAccount(database.db)));
    const blocked = await createAccount(database.db, { status: "blocked" });
    const deleted = await createAccount(database.db, { status: "deleted" });
    const before = await database.db.select({ n: sql<number>`count(*)::int` }).from(users).where(sql`${users.status} <> 'deleted'`);

    const credited = await openIpo(seasonId, new Date("2029-03-25T19:00:00Z"));
    expect(credited).toBe(before[0]!.n);
    expect(await walletOf(seasonId, blocked.id)).toBeDefined();
    expect(await walletOf(seasonId, deleted.id)).toBeUndefined();
    for (const a of active) expect((await walletOf(seasonId, a.id))!.cash).toBe(10_000_000);

    const sum = await database.db
      .select({ cash: sql<number>`sum(${wallets.cash})::bigint`, n: sql<number>`count(*)::int` })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "user")));
    expect(Number(sum[0]!.cash)).toBe(10_000_000 * sum[0]!.n);
    expect(await database.db.select().from(positions).innerJoin(wallets, eq(wallets.id, positions.walletId)).where(eq(wallets.seasonId, seasonId))).toHaveLength(0);

    expect(await openIpo(seasonId, new Date("2029-03-25T19:01:00Z"))).toBe(0);
    const again = await database.db.select({ n: sql<number>`count(*)::int` }).from(wallets).where(eq(wallets.seasonId, seasonId));
    expect(again[0]!.n).toBe(sum[0]!.n);
    await assertLedgerConsistent(database.db, seasonId);
  });

  it("corrida: 20 cadastros ao mesmo tempo que a abertura, 5 vezes: cada conta com exatamente uma carteira de R$ 100 mil", async () => {
    for (let round = 0; round < 5; round++) {
      const year = 2030 + round;
      const { seasonId } = await seedSeason(database.db, year);
      const people = await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const subject = `${String(round).padStart(8, "0")}-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`;
          const email = `corrida${round}_${i}@exemplo.com`;
          await database.db.insert(invites).values({ email });
          return { email, token: await tokenFor({ subject, email, at: clock.now() }) };
        }),
      );
      const signups = people.map((p, i) =>
        app.inject({ method: "POST", url: "/me", headers: bearer(p.token), payload: { nickname: `corr_${round}_${i}`, acceptTerms: true } }),
      );
      const [opened, ...results] = await Promise.all([openIpo(seasonId, new Date(`${year}-03-25T19:00:00Z`)), ...signups]);
      void opened;
      for (const r of results) expect(r.statusCode).toBe(201);

      const rows = await database.db
        .select({ userId: wallets.userId, cash: wallets.cash })
        .from(wallets)
        .innerJoin(users, eq(users.id, wallets.userId))
        .where(and(eq(wallets.seasonId, seasonId), sql`${users.email} like ${`corrida${round}_%`}`));
      expect(rows).toHaveLength(20);
      for (const r of rows) expect(r.cash).toBe(10_000_000);
      await assertLedgerConsistent(database.db, seasonId);
    }
  });
});
