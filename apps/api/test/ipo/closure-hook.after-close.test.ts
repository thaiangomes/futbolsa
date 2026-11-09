import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockClubs, lockSeason, lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { ipoBids, ipoResults, positions, seasonClubs, seasons, users, wallets } from "../../src/infra/db/schema/index.js";
import { AccountClosureHooks, AccountDeletionService } from "../../src/modules/accounts/index.js";
import { IpoBidsService, IpoClosingService, IpoSettlementService } from "../../src/modules/ipo/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

const OPENS_AT = new Date("2027-03-28T19:00:00Z");
const CLOSES_AT = new Date("2027-04-04T19:00:00Z");
const DURING = new Date("2027-03-30T15:00:00Z");
/** 30 segundos depois do horário de fechamento: a tarefa de fechar (a cada minuto) ainda não rodou. */
const LATE = new Date(CLOSES_AT.getTime() + 30_000);
const SETTLE_AT = new Date(CLOSES_AT.getTime() + 60_000);
const BAND = { bandCenter: 5055, bandFloor: 3033, bandCeiling: 7077 };

/**
 * Proposta 8 e critério 14, no intervalo entre o horário de fechamento e a passada da tarefa que muda o
 * status para `ipo_closed`. A oferta do próprio jogador já é recusada nesse intervalo (o relógio manda,
 * não o status); a exclusão e o bloqueio também não podem tirar a oferta do livro, senão o rateio dos
 * outros muda por algo feito depois do fechamento.
 */
describe("gancho do IPO depois do horário de fechamento, com a tarefa de fechar atrasada", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(DURING);
  let app: NestFastifyApplication;
  let seasonId: number;
  let san: number;
  let treasury: number;
  const players = new Map<string, { userId: string; walletId: number }>();
  const wallet = (name: string) => players.get(name)!.walletId;
  const bidOf = async (name: string) => (await database.db.select().from(ipoBids).where(eq(ipoBids.walletId, wallet(name))))[0]!;
  const walletRow = async (name: string) => (await database.db.select().from(wallets).where(eq(wallets.id, wallet(name))))[0]!;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    let clubIds: Map<string, number>;
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    san = clubIds.get("SAN3")!;
    await database.db.insert(seasonClubs).values({ seasonId, clubId: san, division: "A", ...BAND });
    await database.db
      .update(seasons)
      .set({ status: "ipo_open", offerSize: 3000, ipoOpensAt: OPENS_AT, ipoClosesAt: CLOSES_AT, firstKickoff: new Date("2027-04-11T19:00:00Z") })
      .where(eq(seasons.id, seasonId));
    [treasury] = (await openWallets(database.db, seasonId, [{ type: "treasury" }])) as [number];
    for (const name of ["edu", "fabi", "gil"]) {
      const account = await createAccount(database.db, { nickname: name });
      const [walletId] = await openWallets(database.db, seasonId, [{ type: "user", userId: account.id }]);
      players.set(name, { userId: account.id, walletId: walletId! });
    }
  });
  afterAll(() => app?.close());

  it("ipo 14 / proposta 8: exclusão e bloqueio às 16h00min30s com o status ainda ipo_open não cancelam as ofertas, e o rateio é o do fechamento", async () => {
    // SAN3: 1.000 até R$ 40, 1.000 até R$ 38 e 1.000 até R$ 36 → as 3.000 da oferta no corte de R$ 36.
    const bids = app.get(IpoBidsService);
    await bids.place(wallet("edu"), "SAN3", { quantity: 1000, maxPrice: 4000, expect: "new" });
    await bids.place(wallet("fabi"), "SAN3", { quantity: 1000, maxPrice: 3800, expect: "new" });
    await bids.place(wallet("gil"), "SAN3", { quantity: 1000, maxPrice: 3600, expect: "new" });

    clock.set(LATE);
    // O próprio jogador já não cancela: o período fechou pelo relógio.
    await expect(bids.cancel(wallet("edu"), "SAN3")).rejects.toMatchObject({ code: "ipo_closed" });

    // A exclusão nunca é recusada: a carteira fica para depois da liquidação, como no ipo_closed.
    expect(await app.get(AccountDeletionService).deleteAccount(players.get("fabi")!.userId)).toEqual({
      walletCloseout: "after_ipo_settlement",
    });
    // O bloqueio como a F14 vai fazer, na ordem das travas de todo o jogo.
    const hooks = app.get(AccountClosureHooks);
    await withTransaction(database.db, async (tx) => {
      await lockSeason(tx, seasonId, "share");
      await lockClubs(tx, seasonId, await hooks.clubsToLock(tx, wallet("gil")));
      await lockWallets(tx, [wallet("gil")]);
      await tx.db.update(users).set({ status: "blocked" }).where(eq(users.id, players.get("gil")!.userId));
      await hooks.cancelOpen(tx, wallet("gil"), "blocked", clock.now());
    });

    expect(await bidOf("fabi")).toMatchObject({ status: "active", reserved: 1000 * 3800 });
    expect(await bidOf("gil")).toMatchObject({ status: "active", reserved: 1000 * 3600 });
    expect((await walletRow("fabi")).reservedCash).toBe(1000 * 3800);
    expect((await walletRow("gil")).reservedCash).toBe(1000 * 3600);

    // A tarefa fecha e liquida: o rateio é o do livro no fechamento, com as três ofertas.
    expect(await app.get(IpoClosingService).closeIfDue(SETTLE_AT)).toMatchObject({ status: "closed" });
    expect(await app.get(IpoSettlementService).settleDue(SETTLE_AT)).toMatchObject({ status: "ran", failed: [], pending: 0 });
    const [result] = await database.db.select().from(ipoResults).where(and(eq(ipoResults.seasonId, seasonId), eq(ipoResults.clubId, san)));
    expect(result).toMatchObject({ cutPrice: 3600, demandAtCut: 3000, allocationNum: 1, allocationDen: 1, treasuryShares: 0 });

    // As ações do excluído vão para a tesouraria pelo account-closeout; o bloqueado fica com as dele.
    clock.set(SETTLE_AT);
    expect(await app.get(AccountDeletionService).closeoutPending()).toBe(1);
    expect(await walletRow("fabi")).toMatchObject({ cash: 0, reservedCash: 0 });
    const shares = async (walletId: number) =>
      (await database.db.select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, san))))[0]?.shares ?? 0;
    expect(await shares(wallet("fabi"))).toBe(0);
    expect(await shares(wallet("gil"))).toBe(1000);
    expect(await shares(treasury)).toBe(600 + 1000);

    await assertLedgerConsistent(database.db, seasonId);
    await assertSharesConserved(database.db, seasonId);
  });
});
