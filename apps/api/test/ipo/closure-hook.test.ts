import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockClubs, lockSeason, lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { ipoAllocations, ipoBids, ipoResults, positions, seasonClubs, seasons, users, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { AccountClosureHooks, AccountDeletionService } from "../../src/modules/accounts/index.js";
import { IpoBidsService, IpoClosingService, IpoClosureHook, IpoSettlementService } from "../../src/modules/ipo/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

const MINUTE = 60_000;
/** O período de ofertas da temporada de teste: abriu em 2027-03-28 às 16h e fecha em 2027-04-04 às 16h. */
const OPENS_AT = new Date("2027-03-28T19:00:00Z");
const CLOSES_AT = new Date("2027-04-04T19:00:00Z");
const DURING = new Date("2027-03-30T15:00:00Z");
const SETTLE_AT = new Date("2027-04-04T19:01:00Z");
const OFFER = 3000;
/** A faixa do FLA3 do critério 5 (R$ 30,33 a R$ 70,77), igual em todos os clubes do teste. */
const BAND = { bandCenter: 5055, bandFloor: 3033, bandCeiling: 7077 };
/** FLA3 e PAL3 para os cenários com o IPO aberto; SAN3 para o rateio depois do fechamento. */
const TICKERS = ["FLA3", "PAL3", "SAN3"];

/**
 * Gancho de encerramento das ofertas (A6; proposta 8). A aplicação é a de produção: o gancho chega ao
 * `accounts` pelo registro do `IpoModule`, e a exclusão é o `deleteAccount` da F5. O bloqueio pela tela é
 * da F14 e ainda não existe; aqui ele é feito como a F14 vai fazer: temporada travada (compartilhada), os
 * clubes dos ganchos, a carteira, a conta bloqueada e os ganchos chamados com o motivo `blocked`.
 */
describe("gancho de encerramento do IPO", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(DURING);
  let app: NestFastifyApplication;
  let bids: IpoBidsService;
  let hooks: AccountClosureHooks;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  const players = new Map<string, { userId: string; walletId: number }>();

  const club = (ticker: string) => clubIds.get(ticker)!;
  const wallet = (name: string) => players.get(name)!.walletId;

  async function player(name: string) {
    const account = await createAccount(database.db, { nickname: name });
    const [walletId] = await openWallets(database.db, seasonId, [{ type: "user", userId: account.id }]);
    players.set(name, { userId: account.id, walletId: walletId! });
  }

  async function bid(name: string, ticker: string, quantity: number, maxPrice: number) {
    clock.advance(MINUTE);
    await bids.place(wallet(name), ticker, { quantity, maxPrice, expect: "new" });
  }

  /** O bloqueio como a F14 vai fazer, na ordem das travas de todo o jogo. */
  async function block(name: string) {
    await withTransaction(database.db, async (tx) => {
      await lockSeason(tx, seasonId, "share");
      await lockClubs(tx, seasonId, await hooks.clubsToLock(tx, wallet(name)));
      await lockWallets(tx, [wallet(name)]);
      await tx.db.update(users).set({ status: "blocked" }).where(eq(users.id, players.get(name)!.userId));
      await hooks.cancelOpen(tx, wallet(name), "blocked", clock.now());
    });
  }

  const bidOf = async (name: string, ticker: string) =>
    (await database.db.select().from(ipoBids).where(and(eq(ipoBids.walletId, wallet(name)), eq(ipoBids.clubId, club(ticker)))))[0]!;
  const walletRow = async (name: string) => (await database.db.select().from(wallets).where(eq(wallets.id, wallet(name))))[0]!;
  const entriesOf = (name: string) =>
    database.db.select().from(walletEntries).where(eq(walletEntries.walletId, wallet(name))).orderBy(asc(walletEntries.id));
  const sharesOf = async (walletId: number, ticker: string) =>
    (await database.db.select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, club(ticker)))))[0]
      ?.shares ?? 0;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    bids = app.get(IpoBidsService);
    hooks = app.get(AccountClosureHooks);
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    // O estado que a abertura (A2) deixa: faixas gravadas, a tesouraria aberta sem caixa e as ofertas abertas.
    await database.db.insert(seasonClubs).values(TICKERS.map((ticker) => ({ seasonId, clubId: club(ticker), division: "A", ...BAND })));
    await database.db
      .update(seasons)
      .set({ status: "ipo_open", offerSize: OFFER, ipoOpensAt: OPENS_AT, ipoClosesAt: CLOSES_AT, firstKickoff: new Date("2027-04-11T19:00:00Z") })
      .where(eq(seasons.id, seasonId));
    [treasury] = (await openWallets(database.db, seasonId, [{ type: "treasury" }])) as [number];
    for (const name of ["ana", "bruno", "carla", "dora", "edu", "fabi", "gil"]) await player(name);
  });
  afterAll(() => app?.close());

  it("oferta não trava clube: clubsToLock devolve vazio mesmo com ofertas ativas", async () => {
    await bid("ana", "FLA3", 1000, 4000);
    await withTransaction(database.db, async (tx) => {
      expect(await app.get(IpoClosureHook).clubsToLock(tx, wallet("ana"))).toEqual([]);
      expect(await hooks.clubsToLock(tx, wallet("ana"))).toEqual([]);
    });
  });

  it("bloqueio com o IPO aberto: as ofertas no FLA3 e no PAL3 ficam cancelled e a reserva volta ao caixa livre", async () => {
    await bid("ana", "PAL3", 500, 3500);
    expect((await walletRow("ana")).reservedCash).toBe(1000 * 4000 + 500 * 3500);
    const before = (await entriesOf("ana")).length;

    clock.advance(MINUTE);
    await block("ana");

    expect(await bidOf("ana", "FLA3")).toMatchObject({ status: "cancelled", reserved: 0, updatedAt: clock.now() });
    expect(await bidOf("ana", "PAL3")).toMatchObject({ status: "cancelled", reserved: 0 });
    // O bloqueado continua dono do caixa: só a reserva é liberada.
    expect(await walletRow("ana")).toMatchObject({ cash: INITIAL_CASH, reservedCash: 0 });
    const released = (await entriesOf("ana")).slice(before);
    expect(released.map((e) => [e.kind, e.reservedCashDelta, e.cashDelta, e.at])).toEqual([
      ["ipo_reserve", -(1000 * 4000), 0, clock.now()],
      ["ipo_reserve", -(500 * 3500), 0, clock.now()],
    ]);
    expect((await database.db.select().from(users).where(eq(users.id, players.get("ana")!.userId)))[0]!.status).toBe("blocked");
  });

  it("exclusão com o IPO aberto, pela F5: a oferta fica cancelled, a reserva é liberada e a carteira é encerrada na hora", async () => {
    await bid("bruno", "FLA3", 2000, 5000);
    expect((await walletRow("bruno")).reservedCash).toBe(2000 * 5000);
    clock.advance(MINUTE);

    // Sem o gancho do IPO registrado, o encerramento acharia o caixa reservado e falharia.
    expect(await app.get(AccountDeletionService).deleteAccount(players.get("bruno")!.userId)).toEqual({ walletCloseout: "done" });

    expect(await bidOf("bruno", "FLA3")).toMatchObject({ status: "cancelled", reserved: 0 });
    expect(await walletRow("bruno")).toMatchObject({ cash: 0, reservedCash: 0 });
    const lines = (await entriesOf("bruno")).slice(-2);
    expect(lines.map((e) => [e.kind, e.reservedCashDelta, e.cashDelta])).toEqual([
      ["ipo_reserve", -(2000 * 5000), 0],
      ["account_deleted", 0, -INITIAL_CASH],
    ]);
  });

  it("conta sem oferta: o gancho não grava nada nem muda a carteira", async () => {
    const before = await entriesOf("carla");
    await withTransaction(database.db, async (tx) => {
      await lockSeason(tx, seasonId, "share");
      await lockWallets(tx, [wallet("carla")]);
      await app.get(IpoClosureHook).cancelOpen(tx, wallet("carla"), "blocked", clock.now());
    });
    expect(await entriesOf("carla")).toEqual(before);
    expect(await walletRow("carla")).toMatchObject({ cash: INITIAL_CASH, reservedCash: 0 });
  });

  it("chamado sem a temporada travada por quem chama, falha e a oferta fica como estava", async () => {
    await bid("dora", "PAL3", 1000, 3500);
    await expect(
      withTransaction(database.db, async (tx) => {
        await lockWallets(tx, [wallet("dora")]);
        await app.get(IpoClosureHook).cancelOpen(tx, wallet("dora"), "deleted", clock.now());
      }),
    ).rejects.toThrow(/temporada .*travada/);
    expect(await bidOf("dora", "PAL3")).toMatchObject({ status: "active", reserved: 1000 * 3500 });
    expect((await walletRow("dora")).reservedCash).toBe(1000 * 3500);
  });

  it("proposta 8: no ipo_closed, exclusão e bloqueio não cancelam nada; as ofertas ficam active com a reserva presa", async () => {
    // SAN3: 1.000 até R$ 40, 1.000 até R$ 38 e 1.000 até R$ 36 → 3.000 no corte de R$ 36, a oferta exata.
    await bid("edu", "SAN3", 1000, 4000);
    await bid("fabi", "SAN3", 1000, 3800);
    await bid("gil", "SAN3", 1000, 3600);
    expect(await app.get(IpoClosingService).closeIfDue(CLOSES_AT)).toMatchObject({ status: "closed" });
    clock.set(new Date(CLOSES_AT.getTime() + 30_000));

    expect(await app.get(AccountDeletionService).deleteAccount(players.get("fabi")!.userId)).toEqual({
      walletCloseout: "after_ipo_settlement",
    });
    await block("gil");

    expect(await bidOf("fabi", "SAN3")).toMatchObject({ status: "active", reserved: 1000 * 3800 });
    expect(await bidOf("gil", "SAN3")).toMatchObject({ status: "active", reserved: 1000 * 3600 });
    expect((await walletRow("fabi")).reservedCash).toBe(1000 * 3800);
    expect((await walletRow("gil")).reservedCash).toBe(1000 * 3600);
    expect((await entriesOf("gil")).filter((e) => e.kind === "ipo_reserve")).toHaveLength(1);
  });

  it("proposta 8: as ofertas do excluído e do bloqueado entram no rateio; as ações do excluído vão para a tesouraria pelo account-closeout", async () => {
    expect(await app.get(IpoSettlementService).settleDue(SETTLE_AT)).toMatchObject({ status: "ran", failed: [], pending: 0 });

    // Sem as duas ofertas, a demanda seria 1.000 e o corte o piso; com elas, R$ 36 e fração 1/1.
    const [result] = await database.db
      .select()
      .from(ipoResults)
      .where(and(eq(ipoResults.seasonId, seasonId), eq(ipoResults.clubId, club("SAN3"))));
    expect(result).toMatchObject({ cutPrice: 3600, demandAtCut: 3000, allocationNum: 1, allocationDen: 1, treasuryShares: 0 });
    for (const name of ["edu", "fabi", "gil"]) {
      const b = await bidOf(name, "SAN3");
      expect(b.status, name).toBe("settled");
      expect((await database.db.select().from(ipoAllocations).where(eq(ipoAllocations.bidId, b.id)))[0], name).toMatchObject({
        shares: 1000,
        paid: 1000 * 3600,
      });
    }
    expect(await sharesOf(wallet("gil"), "SAN3")).toBe(1000);
    expect(await sharesOf(wallet("fabi"), "SAN3")).toBe(1000);

    // O bloqueado continua dono das ações; as do excluído vão para a tesouraria depois da liquidação.
    const lot = await sharesOf(treasury, "SAN3");
    expect(await app.get(AccountDeletionService).closeoutPending()).toBe(1);
    expect(await sharesOf(wallet("fabi"), "SAN3")).toBe(0);
    expect(await walletRow("fabi")).toMatchObject({ cash: 0, reservedCash: 0 });
    expect(await sharesOf(treasury, "SAN3")).toBe(lot + 1000);
    expect(await sharesOf(wallet("gil"), "SAN3")).toBe(1000);

    await assertLedgerConsistent(database.db, seasonId);
    await assertSharesConserved(database.db, seasonId);
  });
});
