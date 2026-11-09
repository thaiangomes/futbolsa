import "reflect-metadata";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IPO_BLOCKER_MESSAGES, meResponseSchema, overviewSchema } from "@futbolsa/contracts";
import { cupExpected, ipoBand, ipoDates, LIBERTADORES, COPA_DO_BRASIL, type Match, placementPrice, prepareCups } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import {
  bots,
  clubs,
  invites,
  matches,
  positions,
  seasonClubs,
  seasonCups,
  seasonRules,
  seasons,
  users,
  walletEntries,
  wallets,
} from "../../src/infra/db/schema/index.js";
import { BOT_PROFILES } from "../../src/infra/db/schema/values.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { IpoOpeningService } from "../../src/modules/ipo/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, tokenFor, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, rng, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent } from "../support/invariants.js";

const MINUTE = 60_000;

/**
 * A lista da temporada: os 20 da Série A com a colocação anterior (o FLA3 em 3º, o PAL3 em 1º, os quatro
 * promovidos com 21 a 24) e um clube do Clube dos Treze na Série B, sem colocação.
 */
const SERIE_A: ReadonlyArray<readonly [string, number]> = [
  ["PAL3", 1], ["FLU3", 2], ["FLA3", 3], ["VAS3", 4], ["BOT3", 5], ["COR3", 6], ["SAO3", 7], ["SAN3", 8],
  ["GRE3", 9], ["INT3", 10], ["CRU3", 11], ["CAM3", 12], ["BAH3", 13], ["FOR3", 14], ["CEA3", 15], ["SPT3", 16],
  ["JUV3", 21], ["VIT3", 22], ["MIR3", 23], ["RBB3", 24],
];
const SERIE_B_TICKER = "CTB3";

/** 16h de Brasília do dia 11 de abril do ano: o primeiro jogo da 1ª rodada. */
const firstKickoffOf = (year: number) => new Date(`${year}-04-11T19:00:00Z`);

describe("abertura do IPO", () => {
  const database = useTestDatabase(40);
  const clock = new FixedClock(new Date("2027-03-25T12:00:00Z"));
  let app: NestFastifyApplication;
  let opening: IpoOpeningService;
  let values: SeasonValuesService;
  let admin: TestAccount;
  let bruno: TestAccount;
  let clubIds: Map<string, number>;
  /** Clubes de fora da lista, só das copas. */
  let ext: number[];

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    opening = app.get(IpoOpeningService);
    values = app.get(SeasonValuesService, { strict: false });
    await database.db.insert(clubs).values({ ticker: SERIE_B_TICKER, name: "Clube dos Treze na Série B (teste)" });
    ext = (
      await database.db
        .insert(clubs)
        .values([{ name: "Estudiantes (teste)" }, { name: "Nacional (teste)" }, { name: "Botafogo-PB (teste)" }])
        .returning({ id: clubs.id })
    ).map((c) => c.id);
    ({ clubIds } = await seedSeason(database.db, 2027));
    admin = await createAccount(database.db, { role: "admin", nickname: "chefe" });
    bruno = await createAccount(database.db, { nickname: "bruno_hist" });
    // Bots dos 9 perfis ligados e um desligado.
    await database.db.insert(bots).values([...BOT_PROFILES.map((profile) => ({ profile, active: true })), { profile: "trader", active: false }]);
  });
  afterAll(() => app?.close());

  const tokenNow = (account: TestAccount) => account.tokenWith({ at: clock.now() });
  const adminCall = async (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(await tokenNow(admin)), ...(payload ? { payload } : {}) });

  /**
   * Uma temporada em preparação pronta para abrir: valores copiados, tabelas das copas confirmadas (menos as
   * de `unconfirmed`), oferta de 3.000, primeiro jogo no dia 11 de abril às 16h e a lista de clubes. A
   * temporada anterior é encerrada antes (só uma fica fora de `closed`).
   */
  async function prepareSeason(year: number, o: { unconfirmed?: string[] } = {}) {
    await database.db.update(seasons).set({ status: "closed" }).where(ne(seasons.year, year));
    const { seasonId } = await seedSeason(database.db, year);
    await withTransaction(database.db, (tx) => values.createInitial(tx, seasonId));
    await database.db
      .update(seasonCups)
      .set({ confirmedAt: new Date(`${year}-03-01T12:00:00Z`), confirmedBy: admin.id })
      .where(and(eq(seasonCups.seasonId, seasonId), notInArray(seasonCups.competition, o.unconfirmed ?? ["-"])));
    const firstKickoff = firstKickoffOf(year);
    const dates = ipoDates(firstKickoff.getTime());
    // O mesmo que o PATCH da F7 grava (as datas previstas saem do primeiro jogo).
    await database.db
      .update(seasons)
      .set({
        offerSize: 3000,
        firstKickoff,
        ipoOpensAt: new Date(dates.opensAt),
        ipoClosesAt: new Date(dates.closesAt),
        tradingOpensAt: new Date(dates.tradingOpensAt),
      })
      .where(eq(seasons.id, seasonId));
    await database.db.insert(seasonClubs).values([
      ...SERIE_A.map(([ticker, prevPlacement]) => ({ seasonId, clubId: clubIds.get(ticker)!, division: "A", prevPlacement })),
      { seasonId, clubId: clubIds.get(SERIE_B_TICKER)!, division: "B", prevPlacement: null },
    ]);
    return { seasonId, dates };
  }

  const seasonRow = async (seasonId: number) => (await database.db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!;
  const walletOf = async (seasonId: number, userId: string) =>
    (await database.db.select().from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, userId))))[0];
  const walletCount = async (seasonId: number) =>
    (await database.db.select({ n: sql<number>`count(*)::int` }).from(wallets).where(eq(wallets.seasonId, seasonId)))[0]!.n;
  const bandOf = async (seasonId: number, ticker: string) => {
    const [row] = await database.db
      .select({ center: seasonClubs.bandCenter, floor: seasonClubs.bandFloor, ceiling: seasonClubs.bandCeiling })
      .from(seasonClubs)
      .where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubIds.get(ticker)!)));
    return row!;
  };

  describe("temporada de 2027", () => {
    let seasonId: number;
    let dates: ReturnType<typeof ipoDates>;
    let ana: TestAccount;
    let blocked: TestAccount;
    let deleted: TestAccount;

    beforeAll(async () => {
      ({ seasonId, dates } = await prepareSeason(2027));
      ana = await createAccount(database.db, { nickname: "anagol", at: new Date("2027-03-20T12:00:00Z") });
      await database.db.update(users).set({ createdAt: new Date("2027-03-20T12:00:00Z") }).where(eq(users.id, ana.id));
      blocked = await createAccount(database.db, { status: "blocked" });
      deleted = await createAccount(database.db, { status: "deleted" });

      // Jogos das copas que o admin tem na abertura. O FLA3 na Libertadores desde os grupos e na Copa do Brasil
      // na 3ª fase (a que leva às oitavas), os dois depois do fechamento; o BOT3 eliminado na 2ª fase da Copa do
      // Brasil antes do fechamento.
      const [estudiantes, nacional, botafogoPb] = ext as [number, number, number];
      const fla = clubIds.get("FLA3")!;
      await database.db.insert(matches).values([
        { seasonId, competition: "libertadores", phase: "grupos", homeClubId: fla, awayClubId: estudiantes, kickoff: new Date("2027-04-08T00:30:00Z"), source: "t", sourceId: "lib-1" },
        { seasonId, competition: "libertadores", phase: "grupos", homeClubId: nacional, awayClubId: fla, kickoff: new Date("2027-04-22T00:30:00Z"), source: "t", sourceId: "lib-2" },
        {
          seasonId, competition: "copa-do-brasil", phase: "2a-fase", homeClubId: clubIds.get("BOT3")!, awayClubId: botafogoPb,
          kickoff: new Date("2027-03-10T22:00:00Z"), finishedAt: new Date("2027-03-10T23:55:00Z"), homeGoals: 0, awayGoals: 1,
          advancedClubId: botafogoPb, status: "finished", source: "t", sourceId: "cdb-1",
        },
        { seasonId, competition: "copa-do-brasil", phase: "3a-fase", homeClubId: botafogoPb, awayClubId: fla, kickoff: new Date("2027-04-29T22:00:00Z"), source: "t", sourceId: "cdb-2" },
      ]);
    });

    it("conta 12 (antes): conta criada em 2027-03-20 vê R$ 0,00 em 2027-03-25, sem carteira, com a data de abertura", async () => {
      expect(await opening.openIfDue(clock.now())).toEqual({ status: "idle" });
      expect(await walletOf(seasonId, ana.id)).toBeUndefined();
      const me = meResponseSchema.parse((await app.inject({ method: "GET", url: "/me", headers: bearer(await tokenNow(ana)) })).json());
      expect(me).toMatchObject({ registered: true, season: { status: "preparing", hasWallet: false, ipoOpensAt: "2027-03-28T19:00:00.000Z" } });
    });

    it("ipo 1 e admin 19: às 15h59 de 2027-03-28 não abre; às 16h abre sozinho, com fechamento em 04-04 às 16h e negociação em 04-05 às 10h", async () => {
      clock.set(new Date("2027-03-28T18:59:00Z"));
      expect(await opening.openIfDue(clock.now())).toEqual({ status: "idle" });
      expect((await seasonRow(seasonId)).status).toBe("preparing");
      expect(await walletCount(seasonId)).toBe(0);
      expect((await database.db.select().from(seasonRules).where(eq(seasonRules.seasonId, seasonId)))[0]!.lockedAt).toBeNull();

      // Só o relógio avança: nenhuma ação do admin entre as duas passadas.
      clock.advance(MINUTE);
      const result = await opening.openIfDue(clock.now());
      expect(result).toMatchObject({ status: "opened", seasonId });
      const season = await seasonRow(seasonId);
      expect(season.status).toBe("ipo_open");
      expect(season.ipoOpensAt!.toISOString()).toBe("2027-03-28T19:00:00.000Z");
      expect(season.ipoClosesAt!.toISOString()).toBe("2027-04-04T19:00:00.000Z");
      expect(season.tradingOpensAt!.toISOString()).toBe("2027-04-05T13:00:00.000Z");
      expect(season.firstKickoff!.toISOString()).toBe("2027-04-11T19:00:00.000Z");
      expect(new Date(dates.closesAt).toISOString()).toBe("2027-04-04T19:00:00.000Z");
      // Os valores de dividendos ficam travados na abertura.
      expect((await database.db.select().from(seasonRules).where(eq(seasonRules.seasonId, seasonId)))[0]!.lockedAt).toEqual(clock.now());
    });

    it("conta 12 (depois): às 16h a conta tem R$ 100.000,00 em caixa e nenhuma ação", async () => {
      const wallet = await walletOf(seasonId, ana.id);
      expect(wallet).toMatchObject({ cash: INITIAL_CASH, reservedCash: 0, entryMode: "ipo", enteredAt: clock.now() });
      expect(await database.db.select().from(positions).where(eq(positions.walletId, wallet!.id))).toHaveLength(0);
      const me = meResponseSchema.parse((await app.inject({ method: "GET", url: "/me", headers: bearer(await tokenNow(ana)) })).json());
      expect(me).toMatchObject({ season: { status: "ipo_open", hasWallet: true } });
    });

    it("ipo 5 pelo banco: FLA3 3º com R$ 4,22 de copas esperadas tem a faixa de R$ 30,33 a R$ 70,77 (e 2, 3, 4 e 6)", async () => {
      // A conta do motor com os mesmos jogos: Libertadores desde os grupos (R$ 2,53125) e Copa do Brasil na 3ª fase
      // (R$ 1,6875) somam R$ 4,21875, arredondados para R$ 4,22.
      const m = (id: string, competition: string, phase: string, home: string, away: string, kickoff: string, extra: Partial<Match> = {}): Match => ({
        id, competition, phase, home, away, kickoff, homeGoals: null, awayGoals: null, status: "scheduled", ...extra,
      });
      const cups = prepareCups([
        { rules: LIBERTADORES, matches: [m("1", "libertadores", "grupos", "FLA3", "EXT-1", "2027-04-08T00:30:00Z"), m("2", "libertadores", "grupos", "EXT-2", "FLA3", "2027-04-22T00:30:00Z")] },
        {
          rules: COPA_DO_BRASIL,
          matches: [
            m("3", "copa-do-brasil", "2a-fase", "BOT3", "EXT-3", "2027-03-10T22:00:00Z", { status: "finished", homeGoals: 0, awayGoals: 1, finishedAt: "2027-03-10T23:55:00Z", winner: "EXT-3" }),
            m("4", "copa-do-brasil", "3a-fase", "EXT-3", "FLA3", "2027-04-29T22:00:00Z"),
          ],
        },
      ]);
      expect(cupExpected("FLA3", dates.closesAt, cups)).toBe(422);
      expect(ipoBand({ placement: 3, cupExpected: 422, buybackBp: 15_000 })).toMatchObject({ center: 5055, floor: 3033, ceiling: 7077 });

      expect(await bandOf(seasonId, "FLA3")).toEqual({ center: 5055, floor: 3033, ceiling: 7077 });
      // ipo 2: 1º sem copa
      expect(await bandOf(seasonId, "PAL3")).toEqual({ center: 5000, floor: 3000, ceiling: 7000 });
      // ipo 3: Clube dos Treze na Série B, sem colocação
      expect(await bandOf(seasonId, SERIE_B_TICKER)).toEqual({ center: 300, floor: 180, ceiling: 420 });
      // ipo 4: os quatro promovidos, na ordem da Série B
      const promoted = await Promise.all(["JUV3", "VIT3", "MIR3", "RBB3"].map(async (t) => (await bandOf(seasonId, t)).center));
      expect(promoted).toEqual([900, 700, 500, 300]);
      // ipo 6: eliminado da Copa do Brasil antes do fechamento: as copas somam zero
      expect((await bandOf(seasonId, "BOT3")).center).toBe(placementPrice(5));
      // todo clube listado tem faixa
      const missing = await database.db
        .select()
        .from(seasonClubs)
        .where(and(eq(seasonClubs.seasonId, seasonId), sql`${seasonClubs.bandCenter} is null or ${seasonClubs.bandFloor} is null or ${seasonClubs.bandCeiling} is null`));
      expect(missing).toHaveLength(0);
    });

    it("ipo 7: depois da abertura, mudar a oferta para 4.000 pela rota da temporada é recusado e ela continua 3.000", async () => {
      const res = await adminCall("PATCH", `/admin/seasons/${seasonId}`, { offerSize: 4000 });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ipo_opened");
      expect((await seasonRow(seasonId)).offerSize).toBe(3000);
    });

    it("conta 18: toda conta ativa ou bloqueada tem R$ 100.000,00 e nenhuma ação; a soma é R$ 100 mil × contas; a excluída fica sem carteira", async () => {
      const [{ n: accounts }] = (await database.db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(ne(users.status, "deleted"))) as [{ n: number }];
      const [sum] = await database.db
        .select({ cash: sql<string>`sum(${wallets.cash})`, n: sql<number>`count(*)::int` })
        .from(wallets)
        .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "user")));
      expect(sum!.n).toBe(accounts);
      expect(Number(sum!.cash)).toBe(INITIAL_CASH * accounts);
      expect(await walletOf(seasonId, blocked.id)).toMatchObject({ cash: INITIAL_CASH });
      expect(await walletOf(seasonId, deleted.id)).toBeUndefined();
      const held = await database.db.select().from(positions).innerJoin(wallets, eq(wallets.id, positions.walletId)).where(eq(wallets.seasonId, seasonId));
      expect(held).toHaveLength(0);
    });

    it("carteiras da tesouraria (sem caixa) e dos bots ativos (R$ 100.000,00) abertas; o bot desligado fica sem", async () => {
      const [treasury, ...more] = await database.db
        .select()
        .from(wallets)
        .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
      expect(more).toHaveLength(0);
      expect(treasury).toMatchObject({ cash: 0, reservedCash: 0 });
      const botRows = await database.db.select().from(bots);
      const botWallets = await database.db.select().from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "bot")));
      expect(botWallets.map((w) => w.botId).sort()).toEqual(botRows.filter((b) => b.active).map((b) => b.id).sort());
      expect(botWallets).toHaveLength(BOT_PROFILES.length);
      for (const w of botWallets) expect(w).toMatchObject({ cash: INITIAL_CASH, entryMode: "ipo" });
    });

    it("repetível: uma segunda passada não credita de novo nem muda as faixas", async () => {
      const before = await walletCount(seasonId);
      const band = await bandOf(seasonId, "FLA3");
      clock.advance(MINUTE);
      expect(await opening.openIfDue(clock.now())).toEqual({ status: "idle" });
      expect(await walletCount(seasonId)).toBe(before);
      expect(await bandOf(seasonId, "FLA3")).toEqual(band);
      const initials = await database.db
        .select({ walletId: walletEntries.walletId, n: sql<number>`count(*)::int` })
        .from(walletEntries)
        .innerJoin(wallets, eq(wallets.id, walletEntries.walletId))
        .where(and(eq(wallets.seasonId, seasonId), eq(walletEntries.kind, "initial")))
        .groupBy(walletEntries.walletId);
      expect(initials).toHaveLength(before - 1); // todas menos a tesouraria, que abre sem caixa
      for (const row of initials) expect(row.n).toBe(1);
      await assertLedgerConsistent(database.db, seasonId);
    });
  });

  describe("temporada de 2028", () => {
    it("dividendos 28 e conta 17: com a Libertadores sem confirmar, não abre e o motivo aparece; confirmada, abre na passada seguinte, e quem não entra desde 2027 recebe", async () => {
      // Bruno tem conta desde antes do IPO de 2027 (ganhou a carteira de 2027) e não entra desde então.
      const [s2027] = await database.db.select().from(seasons).where(eq(seasons.year, 2027));
      expect(await walletOf(s2027!.id, bruno.id)).toBeDefined();

      const { seasonId, dates } = await prepareSeason(2028, { unconfirmed: ["libertadores"] });
      clock.set(new Date(dates.opensAt));
      const blocked = await opening.openIfDue(clock.now());
      expect(blocked).toEqual({ status: "blocked", seasonId, blockers: ["cups_not_confirmed"] });
      expect(IPO_BLOCKER_MESSAGES.cups_not_confirmed).toMatch(/copa/);
      expect((await seasonRow(seasonId)).status).toBe("preparing");
      expect(await walletCount(seasonId)).toBe(0);
      expect((await database.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, seasonId)))[0]!.bandCenter).toBeNull();
      const overview = overviewSchema.parse((await adminCall("GET", "/admin/overview")).json());
      expect(overview.ipoBlockers).toEqual(["cups_not_confirmed"]);
      expect(overview.cupsNotConfirmed).toEqual(["libertadores"]);

      expect((await adminCall("POST", `/admin/seasons/${seasonId}/cups/libertadores/confirm`)).statusCode).toBe(200);
      clock.advance(MINUTE);
      expect(await opening.openIfDue(clock.now())).toMatchObject({ status: "opened", seasonId });
      const season = await seasonRow(seasonId);
      expect(season.status).toBe("ipo_open");
      // O fechamento continua 7 dias antes do primeiro jogo, mesmo com a abertura atrasada.
      expect(season.ipoClosesAt!.getTime()).toBe(dates.closesAt);
      expect(overviewSchema.parse((await adminCall("GET", "/admin/overview")).json()).ipoBlockers).toEqual([]);

      const wallet = await walletOf(seasonId, bruno.id);
      expect(wallet).toMatchObject({ cash: INITIAL_CASH, entryMode: "ipo" });
      expect(await database.db.select().from(positions).where(eq(positions.walletId, wallet!.id))).toHaveLength(0);
      expect((await database.db.select().from(users).where(eq(users.id, bruno.id)))[0]!.nickname).toBe("bruno_hist");
      // E a de 2027 continua lá, com o histórico.
      expect(await walletOf(s2027!.id, bruno.id)).toBeDefined();
      await assertLedgerConsistent(database.db, seasonId);
    });
  });

  describe("concorrência", () => {
    /**
     * As contas das rodadas anteriores saem do caminho (excluídas): sem isso cada abertura creditaria de novo
     * todas as contas já criadas, e a rodada 20 levaria vinte vezes a primeira. O admin fica.
     */
    const retireAccounts = () =>
      database.db
        .update(users)
        .set({ status: "deleted", email: null, nickname: null, deletedAt: clock.now() })
        .where(and(ne(users.status, "deleted"), ne(users.id, admin.id)));

    it("concorrência 6: 30 POST /me durante a abertura, 20 vezes: toda conta com exatamente uma carteira de R$ 100.000,00", async () => {
      const random = rng(6);
      for (let round = 0; round < 20; round++) {
        const year = 2030 + round;
        await retireAccounts();
        const { seasonId, dates } = await prepareSeason(year);
        clock.set(new Date(dates.opensAt));
        const people = await Promise.all(
          Array.from({ length: 30 }, async (_, i) => {
            const email = `c6_${round}_${i}@exemplo.com`;
            await database.db.insert(invites).values({ email });
            return { email, token: await tokenFor({ subject: randomUUID(), email, at: clock.now() }) };
          }),
        );
        // A abertura entra numa posição sorteada entre os cadastros, todos disparados ao mesmo tempo.
        const at = Math.floor(random() * (people.length + 1));
        const signups = people.map(
          (p, i) => () => app.inject({ method: "POST", url: "/me", headers: bearer(p.token), payload: { nickname: `c6_${round}_${i}`, acceptTerms: true } }),
        );
        const tasks: Array<() => Promise<unknown>> = [...signups.slice(0, at), () => opening.openIfDue(clock.now()), ...signups.slice(at)];
        const results = await Promise.all(tasks.map((t) => t()));
        const opened = results[at] as Awaited<ReturnType<IpoOpeningService["openIfDue"]>>;
        expect(opened).toMatchObject({ status: "opened", seasonId });
        for (const r of results.filter((_, i) => i !== at)) expect((r as { statusCode: number }).statusCode).toBe(201);

        const rows = await database.db
          .select({ userId: wallets.userId, cash: wallets.cash, walletId: wallets.id })
          .from(wallets)
          .innerJoin(users, eq(users.id, wallets.userId))
          .where(and(eq(wallets.seasonId, seasonId), inArray(users.email, people.map((p) => p.email))));
        expect(rows).toHaveLength(30);
        expect(new Set(rows.map((r) => r.userId)).size).toBe(30);
        for (const r of rows) expect(r.cash).toBe(INITIAL_CASH);
        const entries = await database.db
          .select({ n: sql<number>`count(*)::int` })
          .from(walletEntries)
          .where(inArray(walletEntries.walletId, rows.map((r) => r.walletId)));
        expect(entries[0]!.n).toBe(30);
        await assertLedgerConsistent(database.db, seasonId);
      }
    }, 240_000);

    it("concorrência 7: duas aberturas ao mesmo tempo, 20 vezes: uma abre, a outra não faz nada, um crédito por conta", async () => {
      for (let round = 0; round < 20; round++) {
        const year = 2060 + round;
        await retireAccounts();
        const { seasonId, dates } = await prepareSeason(year);
        await Promise.all([1, 2, 3, 4, 5].map(() => createAccount(database.db)));
        clock.set(new Date(dates.opensAt));
        const results = await Promise.all([opening.openIfDue(clock.now()), opening.openIfDue(clock.now())]);
        expect(results.map((r) => r.status).sort()).toEqual(["idle", "opened"]);
        const credited = results.find((r) => r.status === "opened") as { credited: number };

        const [{ n: accounts }] = (await database.db
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(ne(users.status, "deleted"))) as [{ n: number }];
        expect(credited.credited).toBe(accounts);
        const perUser = await database.db
          .select({ n: sql<number>`count(*)::int` })
          .from(walletEntries)
          .innerJoin(wallets, eq(wallets.id, walletEntries.walletId))
          .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "user"), eq(walletEntries.kind, "initial")));
        expect(perUser[0]!.n).toBe(accounts);
        const treasuries = await database.db.select().from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
        expect(treasuries).toHaveLength(1);
        await assertLedgerConsistent(database.db, seasonId);
      }
    }, 240_000);
  });
});
