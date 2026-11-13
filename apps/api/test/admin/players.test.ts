import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adjustResponseSchema,
  blockResponseSchema,
  deletePlayerResponseSchema,
  entriesResponseSchema,
  placeOrderResponseSchema,
  playerDetailSchema,
  playersListSchema,
} from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { adminLog, ipoBids, orders, positions, seasons, users, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { marketSeason, type MarketSeason } from "../market/helpers.js";
import { giveShares, openTreasury, syncTotalShares } from "../market/order-helpers.js";

// F14, T2 a T5: ver, bloquear, excluir e ajustar jogadores, pelas rotas, com login e as invariantes de dinheiro.

const TUESDAY = new Date("2027-04-06T18:00:00Z");
const CASH = 1_000_000;

describe("admin de jogadores (HTTP)", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(TUESDAY);
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let admin: TestAccount;
  let treasury: number;
  let keyCounter = 0;

  const auth = async (a: TestAccount) => bearer(await a.tokenWith({ at: clock.now() }));
  const asAdmin = async (method: "GET" | "POST" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...(await auth(admin)), ...headers }, ...(payload ? { payload } : {}) });
  const adjust = (id: string, payload: object, key = `k${++keyCounter}`) =>
    asAdmin("POST", `/admin/players/${id}/adjust`, payload, { "idempotency-key": key });

  /** Um jogador com carteira (R$ 10.000,00) e, se pedido, ações. */
  const player = async (o: { shares?: { ticker: string; quantity: number }; nickname?: string } = {}) => {
    const account = await createAccount(database.db, o.nickname ? { nickname: o.nickname } : {});
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }], CASH);
    if (o.shares) {
      await giveShares(database.db, wallet!, s.clubIds.get(o.shares.ticker)!, o.shares.quantity);
      await syncTotalShares(database.db, s.seasonId);
    }
    return { account, wallet: wallet! };
  };
  const placeOrder = async (a: TestAccount, payload: object) => app.inject({ method: "POST", url: "/orders", payload, headers: await auth(a) });
  const sharesOf = async (walletId: number, ticker: string) => {
    const [p] = await database.db
      .select({ shares: positions.shares })
      .from(positions)
      .where(and(eq(positions.walletId, walletId), eq(positions.clubId, s.clubIds.get(ticker)!)));
    return p?.shares ?? 0;
  };
  const logs = (action: string) => database.db.select().from(adminLog).where(eq(adminLog.action, action));

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    admin = await createAccount(database.db, { role: "admin", nickname: "chefe" });
    treasury = await openTreasury(database.db, s.seasonId);
    await giveShares(database.db, treasury, s.clubIds.get("FLA3")!, 50);
    await syncTotalShares(database.db, s.seasonId);
  });
  afterAll(async () => {
    await assertLedgerConsistent(database.db, s.seasonId);
    await assertSharesConserved(database.db, s.seasonId);
    await app.close();
  });

  it("admin 31: jogador comum recebe 403 em todas as rotas de jogadores", async () => {
    // o token de teste vale perto de T0; o relógio volta para terça no fim
    clock.set(new Date(TOKEN_T0.getTime() + 60_000));
    const target = await player();
    const id = target.account.id;
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/players" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "GET", url: `/admin/players/${id}` });
    await expectAdminOnly(app, database.db, { method: "GET", url: `/admin/players/${id}/entries` });
    await expectAdminOnly(app, database.db, { method: "POST", url: `/admin/players/${id}/block`, payload: { reason: "teste de acesso" } });
    await expectAdminOnly(app, database.db, { method: "POST", url: `/admin/players/${id}/unblock`, payload: { reason: "teste de acesso" } });
    await expectAdminOnly(app, database.db, { method: "DELETE", url: `/admin/players/${id}`, payload: { confirmNickname: "x", reason: "teste de acesso" } });
    await expectAdminOnly(app, database.db, { method: "POST", url: `/admin/players/${id}/adjust`, payload: { asset: "cash", delta: 1, reason: "teste de acesso" } });
    clock.set(TUESDAY);
  });

  describe("ver jogadores (T2)", () => {
    it("a lista busca por prefixo do apelido (sem diferenciar maiúsculas) e por e-mail exato, e traz o patrimônio", async () => {
      const ana = await player({ nickname: "Zeca_Ana" });
      await player({ nickname: "Zeca_Bia" });
      const byPrefix = playersListSchema.parse((await asAdmin("GET", "/admin/players?q=zeca_")).json());
      expect(byPrefix.items.map((i) => i.nickname)).toEqual(["Zeca_Ana", "Zeca_Bia"]);
      expect(byPrefix.items[0]!.equity).toBe(CASH);
      const byEmail = playersListSchema.parse((await asAdmin("GET", `/admin/players?q=${encodeURIComponent(ana.account.email)}`)).json());
      expect(byEmail.items.map((i) => i.id)).toEqual([ana.account.id]);
      // e-mail parcial não acha ninguém
      const partial = playersListSchema.parse((await asAdmin("GET", `/admin/players?q=${encodeURIComponent("zeca_ana@")}`)).json());
      expect(partial.items).toEqual([]);
      // curinga do LIKE não vale
      expect(playersListSchema.parse((await asAdmin("GET", "/admin/players?q=%25")).json()).items).toEqual([]);
    });

    it("a lista pagina sem repetir nem pular", async () => {
      for (let i = 0; i < 3; i++) await player({ nickname: `Pag_${i}` });
      const seen: string[] = [];
      let cursor: string | null = null;
      // o tamanho da página é 50: com a base de teste pequena, uma página só e sem cursor
      const page = playersListSchema.parse((await asAdmin("GET", "/admin/players?q=Pag_")).json());
      seen.push(...page.items.map((i) => i.nickname!));
      cursor = page.nextCursor;
      expect(seen).toEqual(["Pag_0", "Pag_1", "Pag_2"]);
      expect(cursor).toBeNull();
    });

    it("o detalhe mostra a conta com e-mail, a carteira, as ordens abertas e as ofertas, iguais às do jogador", async () => {
      const bruno = await player({ shares: { ticker: "PAL3", quantity: 20 } });
      expect((await placeOrder(bruno.account, { ticker: "PAL3", side: "sell", type: "limit", quantity: 5, limitPrice: 4200 })).statusCode).toBe(201);
      await database.db.insert(ipoBids).values({
        seasonId: s.seasonId, clubId: s.clubIds.get("SPT3")!, walletId: bruno.wallet, quantity: 3, maxPrice: 5000, reserved: 0, status: "cancelled", createdAt: TUESDAY, updatedAt: TUESDAY,
      });
      const detail = playerDetailSchema.parse((await asAdmin("GET", `/admin/players/${bruno.account.id}`)).json());
      expect(detail.account).toMatchObject({ nickname: bruno.account.nickname, email: bruno.account.email, status: "active" });
      expect(detail.wallet!.cash).toEqual({ total: CASH, reserved: 0, free: CASH });
      expect(detail.wallet!.positions[0]).toMatchObject({ shares: 20, inOrders: 5, free: 15 });
      expect(detail.entryMode).toBe("ipo");
      expect(detail.openOrders).toHaveLength(1);
      expect(detail.bids).toEqual([{ ticker: "SPT3", quantity: 3, maxPrice: 5000, reserved: 0, status: "cancelled" }]);
      // o mesmo que o jogador vê em GET /portfolio e GET /orders
      const own = (await app.inject({ method: "GET", url: "/portfolio", headers: await auth(bruno.account) })).json();
      expect(own.cash).toEqual(detail.wallet!.cash);
      expect(own.equity).toBe(detail.wallet!.equity);
      const ownOrders = (await app.inject({ method: "GET", url: "/orders?status=open", headers: await auth(bruno.account) })).json();
      expect(ownOrders.orders).toEqual(detail.openOrders);
    });

    it("o extrato do jogador traz o motivo do ajuste", async () => {
      const carla = await player();
      expect((await adjust(carla.account.id, { asset: "cash", delta: 1234, reason: "bônus da promoção" })).statusCode).toBe(200);
      const entries = entriesResponseSchema.parse((await asAdmin("GET", `/admin/players/${carla.account.id}/entries`)).json());
      expect(entries.items[0]).toMatchObject({ kind: "adjustment", amount: 1234 });
      expect(JSON.stringify(entries.items[0])).toContain("bônus da promoção");
    });

    it("conta excluída aparece sem dados; jogador desconhecido dá 404", async () => {
      const gone = await createAccount(database.db, { status: "deleted" });
      const detail = playerDetailSchema.parse((await asAdmin("GET", `/admin/players/${gone.id}`)).json());
      expect(detail.account).toMatchObject({ nickname: null, email: null, status: "deleted", blockedReason: null });
      expect(detail.wallet).toBeNull();
      const missing = await asAdmin("GET", "/admin/players/00000000-0000-4000-8000-000000000000");
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("player_not_found");
    });

    it("nenhuma rota de jogador comum devolve o e-mail de outra pessoa", async () => {
      const outro = await player({ nickname: "Sigiloso" });
      const res = await app.inject({ method: "GET", url: `/players/Sigiloso` });
      expect(JSON.stringify(res.json())).not.toContain(outro.account.email);
    });
  });

  describe("bloquear e desbloquear (T3)", () => {
    it("admin 25: o bloqueio cancela as ordens abertas com o motivo blocked, recusa a ordem nova e o bloqueado fica com as ações", async () => {
      const dora = await player({ shares: { ticker: "PAL3", quantity: 30 } });
      expect((await placeOrder(dora.account, { ticker: "PAL3", side: "sell", type: "limit", quantity: 10, limitPrice: 4300 })).statusCode).toBe(201);
      expect((await placeOrder(dora.account, { ticker: "PAL3", side: "buy", type: "limit", quantity: 2, limitPrice: 3900 })).statusCode).toBe(201);
      const res = await asAdmin("POST", `/admin/players/${dora.account.id}/block`, { reason: "suspeita de trapaça" });
      expect(res.statusCode).toBe(200);
      expect(blockResponseSchema.parse(res.json())).toEqual({ status: "blocked", cancelledOrders: 2, cancelledBids: 0 });
      const rows = await database.db.select().from(orders).where(eq(orders.walletId, dora.wallet));
      expect(rows.map((o) => [o.status, o.cancelReason])).toEqual([["cancelled", "blocked"], ["cancelled", "blocked"]]);
      const [w] = await database.db.select().from(wallets).where(eq(wallets.id, dora.wallet));
      expect(w).toMatchObject({ cash: CASH, reservedCash: 0, openOrders: 0 });
      expect(await sharesOf(dora.wallet, "PAL3")).toBe(30);
      const refused = await placeOrder(dora.account, { ticker: "PAL3", side: "buy", type: "limit", quantity: 1, limitPrice: 3900 });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe("account_blocked");
      // continua lendo a própria carteira
      expect((await app.inject({ method: "GET", url: "/portfolio", headers: await auth(dora.account) })).statusCode).toBe(200);
      const log = (await logs("player.block")).find((l) => l.targetId === dora.account.id)!;
      expect(log).toMatchObject({ actorId: admin.id, targetId: dora.account.id, reason: "suspeita de trapaça" });
      expect(JSON.stringify(log)).not.toContain(dora.account.email);
      // o registro guarda os ids do que foi cancelado
      expect((log.after as { cancelledOrderIds: number[] }).cancelledOrderIds).toHaveLength(2);
    });

    it("admin 33: bloquear sem motivo é recusado e nada muda; desbloquear volta ao normal e não recoloca ordens", async () => {
      const edu = await player();
      const bad = await asAdmin("POST", `/admin/players/${edu.account.id}/block`, { reason: " " });
      expect(bad.statusCode).toBe(400);
      expect((await database.db.select().from(users).where(eq(users.id, edu.account.id)))[0]!.status).toBe("active");
      expect((await asAdmin("POST", `/admin/players/${edu.account.id}/block`, { reason: "motivo válido" })).statusCode).toBe(200);
      const twice = await asAdmin("POST", `/admin/players/${edu.account.id}/block`, { reason: "motivo válido" });
      expect(twice.statusCode).toBe(409);
      expect(twice.json().code).toBe("already_blocked");
      const unblock = await asAdmin("POST", `/admin/players/${edu.account.id}/unblock`, { reason: "engano do admin" });
      expect(unblock.statusCode).toBe(200);
      const [u] = await database.db.select().from(users).where(eq(users.id, edu.account.id));
      expect(u).toMatchObject({ status: "active", blockedReason: null });
      expect((await placeOrder(edu.account, { ticker: "PAL3", side: "buy", type: "limit", quantity: 1, limitPrice: 3900 })).statusCode).toBe(201);
      const again = await asAdmin("POST", `/admin/players/${edu.account.id}/unblock`, { reason: "engano do admin" });
      expect(again.json().code).toBe("not_blocked");
    });

    it("bloquear a si mesmo dá cannot_target_self; admin bloqueado perde /admin na chamada seguinte e ainda lê a carteira", async () => {
      const self = await asAdmin("POST", `/admin/players/${admin.id}/block`, { reason: "teste" });
      expect(self.statusCode).toBe(409);
      expect(self.json().code).toBe("cannot_target_self");
      const outro = await createAccount(database.db, { role: "admin" });
      await openWallets(database.db, s.seasonId, [{ type: "user", userId: outro.id }], CASH);
      expect((await asAdmin("POST", `/admin/players/${outro.id}/block`, { reason: "admin com problema" })).statusCode).toBe(200);
      const after = await app.inject({ method: "GET", url: "/admin/players", headers: await auth(outro) });
      expect(after.statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/portfolio", headers: await auth(outro) })).statusCode).toBe(200);
    });

    it("bloquear com o IPO aberto cancela a oferta e libera a reserva; no ipo_closed a oferta continua", async () => {
      const gus = await player();
      await database.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, s.seasonId));
      await withTransaction(database.db, async (tx) => {
        await lockWallets(tx, [gus.wallet]);
        await post(tx, { walletId: gus.wallet, at: TUESDAY, kind: "ipo_reserve", reservedCashDelta: 4000, clubId: s.clubIds.get("COR3")! });
      });
      await database.db.insert(ipoBids).values({
        seasonId: s.seasonId, clubId: s.clubIds.get("COR3")!, walletId: gus.wallet, quantity: 1, maxPrice: 4000, reserved: 4000, status: "active", createdAt: new Date("2027-04-06T17:00:00Z"), updatedAt: new Date("2027-04-06T17:00:00Z"),
      });
      await database.db.update(seasons).set({ ipoClosesAt: new Date("2027-04-10T12:00:00Z") }).where(eq(seasons.id, s.seasonId));
      const res = await asAdmin("POST", `/admin/players/${gus.account.id}/block`, { reason: "bloqueio no IPO" });
      expect(blockResponseSchema.parse(res.json()).cancelledBids).toBe(1);
      const [w] = await database.db.select().from(wallets).where(eq(wallets.id, gus.wallet));
      expect(w!.reservedCash).toBe(0);
      await database.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, s.seasonId));
    });
  });

  describe("excluir pelo admin (T4)", () => {
    it("admin 26: o jogador com 200 ações excluído e confirmado deixa as ações na tesouraria", async () => {
      const fla = s.clubIds.get("FLA3")!;
      const before = await sharesOf(treasury, "FLA3");
      const hugo = await player({ shares: { ticker: "SPT3", quantity: 200 } });
      const res = await asAdmin("DELETE", `/admin/players/${hugo.account.id}`, { confirmNickname: hugo.account.nickname, reason: "pedido do titular" });
      expect(res.statusCode).toBe(202);
      expect(deletePlayerResponseSchema.parse(res.json())).toEqual({ walletCloseout: "done" });
      expect(await sharesOf(hugo.wallet, "SPT3")).toBe(0);
      expect(await sharesOf(treasury, "SPT3")).toBe(200);
      expect(await sharesOf(treasury, "FLA3")).toBe(before);
      expect(fla).toBeGreaterThan(0);
      const [u] = await database.db.select().from(users).where(eq(users.id, hugo.account.id));
      expect(u).toMatchObject({ status: "deleted", email: null, nickname: null });
      const [log] = await logs("player.delete");
      expect(log!.reason).toBe("pedido do titular");
      expect(JSON.stringify(log)).not.toContain(hugo.account.email);
      expect((log!.before as { emailFingerprint: string }).emailFingerprint).toMatch(/^hmac:[0-9a-f]{16,}$/);
      // excluir de novo
      const again = await asAdmin("DELETE", `/admin/players/${hugo.account.id}`, { confirmNickname: "x", reason: "pedido do titular" });
      expect(again.statusCode).toBe(404);
      expect(again.json().code).toBe("player_not_found");
    });

    it("apelido errado, sem motivo e a si mesmo são recusados e nada muda", async () => {
      const ivo = await player();
      const wrong = await asAdmin("DELETE", `/admin/players/${ivo.account.id}`, { confirmNickname: "outro", reason: "pedido do titular" });
      expect(wrong.statusCode).toBe(422);
      expect(wrong.json().code).toBe("nickname_mismatch");
      const noReason = await asAdmin("DELETE", `/admin/players/${ivo.account.id}`, { confirmNickname: ivo.account.nickname, reason: "" });
      expect(noReason.statusCode).toBe(400);
      const self = await asAdmin("DELETE", `/admin/players/${admin.id}`, { confirmNickname: "chefe", reason: "pedido do titular" });
      expect(self.json().code).toBe("cannot_target_self");
      expect((await database.db.select().from(users).where(eq(users.id, ivo.account.id)))[0]!.status).toBe("active");
    });
  });

  describe("ajustar saldo (T5)", () => {
    it("admin 27: crédito maior que as ações livres da tesouraria é recusado; o crédito custa o preço exibido", async () => {
      const jose = await player();
      const tooMuch = await adjust(jose.account.id, { asset: "shares", ticker: "FLA3", delta: 51, reason: "ajuste de teste" });
      expect(tooMuch.statusCode).toBe(422);
      expect(tooMuch.json().code).toBe("treasury_insufficient_shares");
      const ok = await adjust(jose.account.id, { asset: "shares", ticker: "FLA3", delta: 30, reason: "ajuste de teste" });
      expect(ok.statusCode).toBe(200);
      expect(adjustResponseSchema.parse(ok.json())).toMatchObject({ delta: 30, price: 4000, after: 30 });
      const [pos] = await database.db.select().from(positions).where(and(eq(positions.walletId, jose.wallet), eq(positions.clubId, s.clubIds.get("FLA3")!)));
      expect(pos).toMatchObject({ shares: 30, cost: 30 * 4000 });
      expect(await sharesOf(treasury, "FLA3")).toBe(20);
      // as duas linhas de extrato têm o motivo e o ref do registro do admin
      const [log] = (await logs("player.adjust")).slice(-1);
      const entries = await database.db.select().from(walletEntries).where(and(eq(walletEntries.kind, "adjustment"), eq(walletEntries.refId, String(log!.id))));
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.reason === "ajuste de teste" && e.refType === "admin_log")).toBe(true);
      // devolve as ações para o resto dos testes
      expect((await adjust(jose.account.id, { asset: "shares", ticker: "FLA3", delta: -30, reason: "desfaz o ajuste" })).statusCode).toBe(200);
      expect(await sharesOf(treasury, "FLA3")).toBe(50);
    });

    it("admin 28: débito de caixa acima do livre é recusado; débito de ações presas em venda é recusado", async () => {
      const lia = await player({ shares: { ticker: "PAL3", quantity: 10 } });
      const cash = await adjust(lia.account.id, { asset: "cash", delta: -(CASH + 1), reason: "débito de teste" });
      expect(cash.statusCode).toBe(422);
      expect(cash.json().code).toBe("adjust_insufficient_cash");
      expect((await placeOrder(lia.account, { ticker: "PAL3", side: "sell", type: "limit", quantity: 8, limitPrice: 4400 })).statusCode).toBe(201);
      const shares = await adjust(lia.account.id, { asset: "shares", ticker: "PAL3", delta: -3, reason: "débito de teste" });
      expect(shares.json().code).toBe("adjust_insufficient_shares");
      expect((await adjust(lia.account.id, { asset: "shares", ticker: "PAL3", delta: -2, reason: "débito de teste" })).statusCode).toBe(200);
      expect(await sharesOf(lia.wallet, "PAL3")).toBe(8);
      expect(await sharesOf(treasury, "PAL3")).toBe(2);
    });

    it("a mesma Idempotency-Key duas vezes credita uma vez só; com outro corpo dá idempotency_conflict; sem a chave, 400", async () => {
      const mel = await player();
      const body = { asset: "cash", delta: 5000, reason: "crédito único" };
      expect((await adjust(mel.account.id, body, "chave-fixa")).statusCode).toBe(200);
      expect((await adjust(mel.account.id, body, "chave-fixa")).statusCode).toBe(200);
      const [w] = await database.db.select().from(wallets).where(eq(wallets.id, mel.wallet));
      expect(w!.cash).toBe(CASH + 5000);
      const conflict = await adjust(mel.account.id, { ...body, delta: 6000 }, "chave-fixa");
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("idempotency_conflict");
      const missing = await asAdmin("POST", `/admin/players/${mel.account.id}/adjust`, body);
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("idempotency_key_required");
    });

    it("recusas de estado: conta excluída, sem carteira e fora da fase; o motivo vazio não passa", async () => {
      const gone = await createAccount(database.db, { status: "deleted" });
      expect((await adjust(gone.id, { asset: "cash", delta: 1, reason: "teste" })).json().code).toBe("player_not_found");
      const semCarteira = await createAccount(database.db);
      expect((await adjust(semCarteira.id, { asset: "cash", delta: 1, reason: "teste" })).json().code).toBe("no_wallet");
      const nia = await player();
      await database.db.update(seasons).set({ status: "trading_ended" }).where(eq(seasons.id, s.seasonId));
      expect((await adjust(nia.account.id, { asset: "shares", ticker: "FLA3", delta: 1, reason: "teste" })).json().code).toBe("adjust_not_allowed");
      expect((await adjust(nia.account.id, { asset: "cash", delta: 100, reason: "caixa no fim" })).statusCode).toBe(200);
      await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, s.seasonId));
      expect((await adjust(nia.account.id, { asset: "cash", delta: 100, reason: "caixa depois" })).statusCode).toBe(409);
      await database.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, s.seasonId));
      expect((await adjust(nia.account.id, { asset: "cash", delta: 100, reason: "" })).statusCode).toBe(400);
    });
  });
});
