import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockWallets, type Tx, withTransaction } from "../../src/infra/db/index.js";
import {
  authIdentities,
  invites,
  ipoResults,
  positions,
  seasonResults,
  seasons,
  users,
  walletEntries,
  wallets,
} from "../../src/infra/db/schema/index.js";
import { AccountClosureHooks, AccountDeletionService, type ClosureHook } from "../../src/modules/accounts/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, FakeIdentityAdmin, tokenFor, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

const NOW = new Date("2027-05-20T15:00:00Z");
const PRICE = 3_500; // R$ 35,00

describe("exclusão da conta", () => {
  const database = useTestDatabase(30);
  const clock = new FixedClock(NOW);
  const identityAdmin = new FakeIdentityAdmin();
  const ledger = new PortfolioLedger();
  let app: NestFastifyApplication;
  let year = 2027;

  /** O gancho de teste que faz o papel do `market` (F9): cancela a ordem de venda aberta. */
  const hookCalls: Array<{ walletId: number; clubLocked: boolean; walletLocked: boolean }> = [];
  const marketHook: ClosureHook = {
    async clubsToLock(tx: Tx, walletId: number) {
      const open = await tx.db.select().from(positions).where(eq(positions.walletId, walletId));
      return open.some((p) => p.reservedShares > 0) ? ["FLA3"] : [];
    },
    async cancelOpen(tx: Tx, walletId: number) {
      hookCalls.push({ walletId, clubLocked: tx.locks.isClubLocked("FLA3"), walletLocked: tx.locks.isWalletLocked(walletId) });
      for (const p of await tx.db.select().from(positions).where(eq(positions.walletId, walletId))) {
        if (p.reservedShares > 0) {
          await ledger.post(tx, { walletId, at: NOW, kind: "order_release", clubId: p.clubId, reservedSharesDelta: -p.reservedShares, openOrdersDelta: -1 });
        }
      }
    },
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock, identityAdmin) });
    app.get(AccountClosureHooks).register(marketHook);
  });
  afterAll(() => app?.close());

  const del = (token: string, confirmNickname: string) =>
    app.inject({ method: "DELETE", url: "/me", headers: bearer(token), payload: { confirmNickname } });

  /** Uma temporada nova (passa a ser a atual), com FLA3 listado e 1.000 ações na tesouraria. */
  async function season(status: string) {
    year++;
    const { seasonId, clubIds } = await seedSeason(database.db, year);
    await database.db.update(seasons).set({ status }).where(eq(seasons.id, seasonId));
    await listClubs(database.db, seasonId, clubIds, ["FLA3"], 1_000);
    const [treasury] = await openWallets(database.db, seasonId, [{ type: "treasury" }]);
    const fla = clubIds.get("FLA3")!;
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [treasury!]);
      await ledger.post(tx, { walletId: treasury!, at: NOW, kind: "ipo_settle", clubId: fla, sharesDelta: 1_000, costBasis: "purchase", price: PRICE });
    });
    return { seasonId, fla, treasury: treasury! };
  }

  /** Carteira do jogador na temporada, comprando `shares` FLA3 da tesouraria, com `cash` no fim. */
  async function holder(s: Awaited<ReturnType<typeof season>>, account: TestAccount, shares: number, cash: number) {
    const [walletId] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }], cash + shares * PRICE);
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [walletId!, s.treasury]);
      if (shares > 0) {
        await ledger.post(tx, { walletId: walletId!, at: NOW, kind: "trade", clubId: s.fla, sharesDelta: shares, cashDelta: -shares * PRICE, costBasis: "purchase", price: PRICE });
        await ledger.post(tx, { walletId: s.treasury, at: NOW, kind: "trade", clubId: s.fla, sharesDelta: -shares, cashDelta: shares * PRICE, costBasis: "sale", price: PRICE });
      }
    });
    return walletId!;
  }

  const fresh = (account: TestAccount, minutesAgo = 1) =>
    account.tokenWith({ at: clock.now(), authenticatedAt: new Date(clock.now().getTime() - minutesAgo * 60_000) });

  it("conta 22: ordem cancelada, 200 FLA3 para a tesouraria, caixa some, e-mail e apelido apagados", async () => {
    const s = await season("trading");
    const davi = await createAccount(database.db, { nickname: "davi_22" });
    const walletId = await holder(s, davi, 200, 500_000);
    // ordem de venda aberta de 100 FLA3: 100 ações reservadas
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [walletId]);
      await ledger.post(tx, { walletId, at: NOW, kind: "order_reserve", clubId: s.fla, reservedSharesDelta: 100, openOrdersDelta: 1 });
    });
    hookCalls.length = 0;

    const res = await del(await fresh(davi), "Davi_22");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ walletCloseout: "done" });

    expect(hookCalls).toEqual([{ walletId, clubLocked: true, walletLocked: true }]);
    const [w] = await database.db.select().from(wallets).where(eq(wallets.id, walletId));
    expect(w).toMatchObject({ cash: 0, reservedCash: 0, openOrders: 0 });
    const [p] = await database.db.select().from(positions).where(eq(positions.walletId, walletId));
    expect(p).toMatchObject({ shares: 0, reservedShares: 0 });
    const [t] = await database.db.select().from(positions).where(and(eq(positions.walletId, s.treasury), eq(positions.clubId, s.fla)));
    expect(t!.shares).toBe(1_000);
    const kinds = await database.db.select({ kind: walletEntries.kind }).from(walletEntries).where(eq(walletEntries.walletId, walletId));
    expect(kinds.filter((k) => k.kind === "account_deleted")).toHaveLength(2);

    const [u] = await database.db.select().from(users).where(eq(users.id, davi.id));
    expect(u).toMatchObject({ status: "deleted", email: null, nickname: null, deletedAt: NOW });
    await assertLedgerConsistent(database.db, s.seasonId);
    await assertSharesConserved(database.db, s.seasonId);
  });

  it("conta 23: Davi não entra de novo sem convite; o apelido fica livre; liberado de novo, nasce outra conta", async () => {
    await season("trading");
    const davi = await createAccount(database.db, { nickname: "davi_23", email: "davi23@exemplo.com" });
    await database.db.insert(invites).values({ email: "davi23@exemplo.com", usedAt: NOW });
    await database.db.insert(seasonResults).values({ userId: davi.id, seasonId: (await database.db.select().from(seasons))[0]!.id, finalEquity: 1, base: 1 });
    expect((await del(await fresh(davi), "davi_23")).statusCode).toBe(202);
    expect(await database.db.select().from(invites).where(eq(invites.email, "davi23@exemplo.com"))).toHaveLength(0);
    // o histórico fica, ligado à conta excluída
    expect(await database.db.select().from(seasonResults).where(eq(seasonResults.userId, davi.id))).toHaveLength(1);

    // a identidade foi apagada no login; a mesma pessoa entra de novo (identidade nova)
    const again = await tokenFor({ subject: "dddddddd-2323-4323-8323-000000000023", email: "davi23@exemplo.com", at: clock.now() });
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(again) })).json()).toEqual({ registered: false, invited: false });
    const blocked = await app.inject({ method: "POST", url: "/me", headers: bearer(again), payload: { nickname: "davi_volta", acceptTerms: true } });
    expect(blocked.json().code).toBe("invite_required");

    const outro = await createAccount(database.db);
    expect((await app.inject({ method: "PATCH", url: "/me/nickname", headers: bearer(await outro.tokenWith({ at: clock.now() })), payload: { nickname: "davi_23" } })).statusCode).toBe(204);

    await database.db.insert(invites).values({ email: "davi23@exemplo.com" });
    const back = await app.inject({ method: "POST", url: "/me", headers: bearer(again), payload: { nickname: "davi_volta", acceptTerms: true } });
    expect(back.statusCode).toBe(201);
    expect(back.json().id).not.toBe(davi.id);
  });

  it("a identidade é apagada no login depois do COMMIT; se o login falhar, a tarefa de limpeza apaga depois", async () => {
    await season("trading");
    const ok = await createAccount(database.db);
    await del(await fresh(ok), ok.nickname);
    expect(identityAdmin.deleted).toContain(ok.subject);
    expect(await database.db.select().from(authIdentities).where(eq(authIdentities.subject, ok.subject))).toHaveLength(0);

    const flaky = await createAccount(database.db);
    const token = await fresh(flaky);
    identityAdmin.failNext = 1;
    expect((await del(token, flaky.nickname)).statusCode).toBe(202);
    expect(identityAdmin.deleted).not.toContain(flaky.subject);
    expect(await database.db.select().from(authIdentities).where(eq(authIdentities.subject, flaky.subject))).toHaveLength(1);
    // o token ainda válido já é recusado
    const res = await app.inject({ method: "GET", url: "/me", headers: bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("account_deleted");

    expect(await app.get(AccountDeletionService).purgeIdentities()).toBeGreaterThanOrEqual(1);
    expect(identityAdmin.deleted).toContain(flaky.subject);
    expect(await database.db.select().from(authIdentities).where(eq(authIdentities.subject, flaky.subject))).toHaveLength(0);
  });

  it("transação desfeita não apaga a identidade no login", async () => {
    await season("trading");
    const admin = await createAccount(database.db, { role: "admin" });
    await database.db.update(users).set({ role: "player" }).where(eq(users.role, "admin"));
    await database.db.update(users).set({ role: "admin" }).where(eq(users.id, admin.id));
    const before = identityAdmin.deleted.length;
    const res = await del(await fresh(admin), admin.nickname);
    expect(res.json().code).toBe("last_admin");
    expect(identityAdmin.deleted.length).toBe(before);
  });

  it("login recente: 16 minutos atrás pede para entrar de novo e nada muda; 14 minutos exclui", async () => {
    await season("trading");
    const ana = await createAccount(database.db);
    const old = await del(await fresh(ana, 16), ana.nickname);
    expect(old.statusCode).toBe(401);
    expect(old.json().code).toBe("reauth_required");
    expect((await database.db.select().from(users).where(eq(users.id, ana.id)))[0]!.status).toBe("active");
    expect((await del(await fresh(ana, 14), ana.nickname)).statusCode).toBe(202);
  });

  it("apelido de confirmação errado recusa; o último admin recebe last_admin; com outro admin, passa", async () => {
    await season("trading");
    const ana = await createAccount(database.db);
    const wrong = await del(await fresh(ana), "outra_pessoa");
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().fields).toEqual(["confirmNickname"]);

    await database.db.update(users).set({ role: "player" }).where(eq(users.role, "admin"));
    const unico = await createAccount(database.db, { role: "admin" });
    expect((await del(await fresh(unico), unico.nickname)).json().code).toBe("last_admin");
    await createAccount(database.db, { role: "admin" });
    expect((await del(await fresh(unico), unico.nickname)).statusCode).toBe(202);
  });

  it("dois admins se excluindo ao mesmo tempo: um passa e o outro recebe last_admin", async () => {
    await season("trading");
    await database.db.update(users).set({ role: "player" }).where(eq(users.role, "admin"));
    const a = await createAccount(database.db, { role: "admin" });
    const b = await createAccount(database.db, { role: "admin" });
    const results = await Promise.all([del(await fresh(a), a.nickname), del(await fresh(b), b.nickname)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
  });

  it("a qualquer momento: a exclusão passa em todos os status da temporada e com a conta bloqueada", async () => {
    for (const status of ["preparing", "ipo_open", "ipo_closed", "trading", "trading_ended", "closed"]) {
      await season(status);
      const p = await createAccount(database.db, { status: status === "trading" ? "blocked" : "active" });
      const res = await del(await fresh(p), p.nickname);
      expect(res.statusCode, status).toBe(202);
    }
  });

  it("IPO fechado e não liquidado: dados somem na hora; a carteira é encerrada depois da liquidação", async () => {
    const s = await season("ipo_closed");
    const davi = await createAccount(database.db, { nickname: "davi_ipo" });
    // oferta de 100 FLA3 a até R$ 35,00: R$ 3.500,00 reservados
    const [walletId] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: davi.id }], 10_000_000);
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [walletId!]);
      await ledger.post(tx, { walletId: walletId!, at: NOW, kind: "ipo_reserve", reservedCashDelta: 350_000 });
    });
    const token = await fresh(davi);
    const res = await del(token, "davi_ipo");
    expect(res.json()).toEqual({ walletCloseout: "after_ipo_settlement" });
    expect((await database.db.select().from(users).where(eq(users.id, davi.id)))[0]).toMatchObject({ status: "deleted", email: null, nickname: null });
    // a identidade já foi apagada no login: o token antigo não chega mais à conta excluída
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(token) })).json()).toEqual({ registered: false, invited: false });
    const deletion = app.get(AccountDeletionService);
    expect(await deletion.closeoutPending()).toBe(0);
    expect((await database.db.select().from(wallets).where(eq(wallets.id, walletId!)))[0]!.reservedCash).toBe(350_000);

    // liquidação (o que a F8 faz): a oferta entra no rateio como estava; Davi recebe 80 FLA3
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [walletId!, s.treasury]);
      await ledger.post(tx, { walletId: walletId!, at: NOW, kind: "ipo_settle", clubId: s.fla, reservedCashDelta: -350_000, cashDelta: -80 * PRICE, sharesDelta: 80, costBasis: "purchase", price: PRICE });
      await ledger.post(tx, { walletId: s.treasury, at: NOW, kind: "ipo_settle", clubId: s.fla, sharesDelta: -80, costBasis: "debit" });
    });
    await database.db.insert(ipoResults).values({ seasonId: s.seasonId, clubId: s.fla, cutPrice: PRICE, demandAtCut: 80, allocationNum: 1, allocationDen: 1, treasuryShares: 0, mmLotShares: 0, settledAt: NOW });

    expect(await deletion.closeoutPending()).toBe(1);
    const [w] = await database.db.select().from(wallets).where(eq(wallets.id, walletId!));
    expect(w).toMatchObject({ cash: 0, reservedCash: 0 });
    const [t] = await database.db.select().from(positions).where(and(eq(positions.walletId, s.treasury), eq(positions.clubId, s.fla)));
    expect(t!.shares).toBe(1_000);
    expect(await deletion.closeoutPending()).toBe(0);
    await assertLedgerConsistent(database.db, s.seasonId);
    await assertSharesConserved(database.db, s.seasonId);
  });

  it("caixa negativo por estorno: a dívida some junto com a conta", async () => {
    const s = await season("trading");
    const bruno = await createAccount(database.db);
    const walletId = await holder(s, bruno, 0, 15_000);
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [walletId]);
      await ledger.post(tx, { walletId, at: NOW, kind: "reversal", clubId: s.fla, cashDelta: -40_000, reason: "placar corrigido" });
    });
    expect((await del(await fresh(bruno), bruno.nickname)).statusCode).toBe(202);
    expect((await database.db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!.cash).toBe(0);
    await assertLedgerConsistent(database.db, s.seasonId);
  });

  it("token de outro usuário: o DELETE /me com o token de Bruno exclui Bruno e nunca Ana", async () => {
    await season("trading");
    const ana = await createAccount(database.db, { nickname: "ana_fica" });
    const bruno = await createAccount(database.db, { nickname: "bruno_sai" });
    expect((await del(await fresh(bruno), "ana_fica")).statusCode).toBe(400);
    expect((await del(await fresh(bruno), "bruno_sai")).statusCode).toBe(202);
    expect((await database.db.select().from(users).where(eq(users.id, ana.id)))[0]!.status).toBe("active");
  });

  it("sem token, 401", async () => {
    expect((await app.inject({ method: "DELETE", url: "/me", payload: { confirmNickname: "x" } })).statusCode).toBe(401);
  });

  it("temporada em preparação, sem carteira: só os dados são apagados", async () => {
    await season("preparing");
    const carla = await createAccount(database.db);
    expect((await del(await fresh(carla), carla.nickname)).json()).toEqual({ walletCloseout: "done" });
  });
});
