import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteBidResponseSchema, putBidResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { invites, ipoBids, seasonClubs, seasons, users, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, tokenFor, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent } from "../support/invariants.js";

/** O período de ofertas da temporada de teste: abriu em 2027-03-28 às 16h e fecha em 2027-04-04 às 16h. */
const OPENS_AT = new Date("2027-03-28T19:00:00Z");
const CLOSES_AT = new Date("2027-04-04T19:00:00Z");
/** Um instante qualquer com as ofertas abertas. */
const DURING = new Date("2027-03-30T15:00:00Z");

/** As faixas gravadas na abertura: o FLA3 do critério 5 (R$ 30,33 a R$ 70,77) e o PAL3 1º sem copa. */
const BANDS = {
  FLA3: { bandCenter: 5055, bandFloor: 3033, bandCeiling: 7077 },
  PAL3: { bandCenter: 5000, bandFloor: 3000, bandCeiling: 7000 },
  BOT3: { bandCenter: 3000, bandFloor: 1800, bandCeiling: 4200 },
} as const;

describe("ofertas do IPO: PUT e DELETE /ipo/bids/:ticker", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(DURING);
  let app: NestFastifyApplication;
  let seasonId: number;
  let clubIds: Map<string, number>;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    // O estado que a abertura (A2) deixa: faixas gravadas e a temporada em `ipo_open`.
    await database.db.insert(seasonClubs).values(
      Object.entries(BANDS).map(([ticker, band]) => ({ seasonId, clubId: clubIds.get(ticker)!, division: "A", ...band })),
    );
    await database.db
      .update(seasons)
      .set({ status: "ipo_open", offerSize: 3000, ipoOpensAt: OPENS_AT, ipoClosesAt: CLOSES_AT, firstKickoff: new Date("2027-04-11T19:00:00Z") })
      .where(eq(seasons.id, seasonId));
  });
  afterAll(() => app?.close());
  beforeEach(() => clock.set(DURING));

  /** Um jogador logado com carteira na temporada (R$ 100.000,00, a não ser que diga outro caixa). */
  async function player(o: { cash?: number; status?: "active" | "blocked" } = {}) {
    const account = await createAccount(database.db, { status: o.status });
    const [walletId] = await openWallets(database.db, seasonId, [{ type: "user", userId: account.id }], o.cash ?? INITIAL_CASH);
    return { account, walletId: walletId! };
  }

  const tokenNow = (account: TestAccount) => account.tokenWith({ at: clock.now() });
  const put = async (account: TestAccount, ticker: string, payload: object) =>
    app.inject({ method: "PUT", url: `/ipo/bids/${ticker}`, headers: bearer(await tokenNow(account)), payload });
  const del = async (account: TestAccount, ticker: string) =>
    app.inject({ method: "DELETE", url: `/ipo/bids/${ticker}`, headers: bearer(await tokenNow(account)) });

  const walletRow = async (walletId: number) => (await database.db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!;
  const bidsOf = (walletId: number) => database.db.select().from(ipoBids).where(eq(ipoBids.walletId, walletId)).orderBy(asc(ipoBids.id));
  const reserveEntries = (walletId: number) =>
    database.db
      .select()
      .from(walletEntries)
      .where(and(eq(walletEntries.walletId, walletId), eq(walletEntries.kind, "ipo_reserve")))
      .orderBy(asc(walletEntries.id));

  /** Recusa sem deixar rastro: nada reservado, nenhuma oferta e nenhuma linha `ipo_reserve`. */
  async function expectNothingReserved(walletId: number) {
    expect((await walletRow(walletId)).reservedCash).toBe(0);
    expect(await bidsOf(walletId)).toHaveLength(0);
    expect(await reserveEntries(walletId)).toHaveLength(0);
  }

  it("ipo 8: 1.500 FLA3 até R$ 40 com R$ 100.000 → R$ 60.000 reservados e R$ 40.000 livres, com a linha ipo_reserve", async () => {
    const { account, walletId } = await player();
    const res = await put(account, "FLA3", { quantity: 1500, maxPrice: 4000, expect: "new" });
    expect(res.statusCode).toBe(200);
    const body = putBidResponseSchema.parse(res.json());
    expect(body).toEqual({
      ticker: "FLA3",
      bid: { quantity: 1500, maxPrice: 4000, reserved: 6_000_000, updatedAt: DURING.toISOString() },
      cash: { total: INITIAL_CASH, reserved: 6_000_000, free: 4_000_000 },
    });

    expect(await walletRow(walletId)).toMatchObject({ cash: INITIAL_CASH, reservedCash: 6_000_000 });
    const [bid] = await bidsOf(walletId);
    expect(bid).toMatchObject({
      seasonId,
      clubId: clubIds.get("FLA3"),
      quantity: 1500,
      maxPrice: 4000,
      reserved: 6_000_000,
      status: "active",
      createdAt: DURING,
      updatedAt: DURING,
    });
    const entries = await reserveEntries(walletId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      at: DURING,
      cashDelta: 0,
      reservedCashDelta: 6_000_000,
      cashAfter: INITIAL_CASH,
      refType: "ipo_bid",
      refId: String(bid!.id),
    });
  });

  it("ipo 9: 100 FLA3 até R$ 90 com teto de R$ 70,77 → reserva de R$ 7.077 (no teto), o preço pedido guardado", async () => {
    const { account, walletId } = await player();
    const body = putBidResponseSchema.parse((await put(account, "FLA3", { quantity: 100, maxPrice: 9000, expect: "new" })).json());
    expect(body.bid).toMatchObject({ quantity: 100, maxPrice: 9000, reserved: 707_700 });
    expect(body.cash).toEqual({ total: INITIAL_CASH, reserved: 707_700, free: INITIAL_CASH - 707_700 });
    expect((await walletRow(walletId)).reservedCash).toBe(707_700);
    expect((await bidsOf(walletId))[0]).toMatchObject({ maxPrice: 9000, reserved: 707_700 });
    expect((await reserveEntries(walletId)).map((e) => e.reservedCashDelta)).toEqual([707_700]);
  });

  it("ipo 10: oferta até R$ 30,32 com piso de R$ 30,33 → below_band_floor e nada é reservado", async () => {
    const { account, walletId } = await player();
    const res = await put(account, "FLA3", { quantity: 100, maxPrice: 3032, expect: "new" });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("below_band_floor");
    await expectNothingReserved(walletId);
    // No piso exato passa.
    expect((await put(account, "FLA3", { quantity: 100, maxPrice: 3033, expect: "new" })).statusCode).toBe(200);
  });

  it("ipo 11: com R$ 40.000 livres, 1.200 até R$ 35 (R$ 42.000) é recusada e o livre continua R$ 40.000", async () => {
    const { account, walletId } = await player();
    // R$ 60.000 presos noutra oferta deixam R$ 40.000 livres.
    expect((await put(account, "PAL3", { quantity: 1500, maxPrice: 4000, expect: "new" })).statusCode).toBe(200);
    const res = await put(account, "FLA3", { quantity: 1200, maxPrice: 3500, expect: "new" });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("insufficient_cash");
    const wallet = await walletRow(walletId);
    expect(wallet.cash - wallet.reservedCash).toBe(4_000_000);
    expect(await bidsOf(walletId)).toHaveLength(1);
    expect(await reserveEntries(walletId)).toHaveLength(1);
    // Reserva exatamente igual ao livre passa: 1.000 até R$ 40 = R$ 40.000.
    const ok = putBidResponseSchema.parse((await put(account, "FLA3", { quantity: 1000, maxPrice: 4000, expect: "new" })).json());
    expect(ok.cash).toEqual({ total: INITIAL_CASH, reserved: INITIAL_CASH, free: 0 });
  });

  it("ipo 12: segunda oferta no FLA3 com expect new → 409 bid_exists e só a primeira fica", async () => {
    const { account, walletId } = await player();
    expect((await put(account, "FLA3", { quantity: 1500, maxPrice: 4000, expect: "new" })).statusCode).toBe(200);
    clock.advance(60_000);
    const res = await put(account, "FLA3", { quantity: 10, maxPrice: 5000, expect: "new" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("bid_exists");
    const bids = await bidsOf(walletId);
    expect(bids).toHaveLength(1);
    expect(bids[0]).toMatchObject({ quantity: 1500, maxPrice: 4000, reserved: 6_000_000, updatedAt: DURING });
    expect((await walletRow(walletId)).reservedCash).toBe(6_000_000);
    expect(await reserveEntries(walletId)).toHaveLength(1);
  });

  it("ipo 13: editar de 1.500 até R$ 40 para 1.000 até R$ 38 → R$ 38.000 (−R$ 22.000 no extrato); cancelar → zero", async () => {
    const { account, walletId } = await player();
    await put(account, "FLA3", { quantity: 1500, maxPrice: 4000, expect: "new" });
    clock.advance(60_000);
    const edited = await put(account, "FLA3", { quantity: 1000, maxPrice: 3800, expect: "existing" });
    expect(edited.statusCode).toBe(200);
    expect(putBidResponseSchema.parse(edited.json())).toEqual({
      ticker: "FLA3",
      bid: { quantity: 1000, maxPrice: 3800, reserved: 3_800_000, updatedAt: clock.now().toISOString() },
      cash: { total: INITIAL_CASH, reserved: 3_800_000, free: INITIAL_CASH - 3_800_000 },
    });
    expect((await walletRow(walletId)).reservedCash).toBe(3_800_000);

    clock.advance(60_000);
    const cancelled = await del(account, "FLA3");
    expect(cancelled.statusCode).toBe(200);
    expect(deleteBidResponseSchema.parse(cancelled.json())).toEqual({
      ticker: "FLA3",
      cash: { total: INITIAL_CASH, reserved: 0, free: INITIAL_CASH },
    });
    expect((await walletRow(walletId)).reservedCash).toBe(0);
    const [bid] = await bidsOf(walletId);
    expect(bid).toMatchObject({ status: "cancelled", reserved: 0, updatedAt: clock.now() });
    const entries = await reserveEntries(walletId);
    expect(entries.map((e) => e.reservedCashDelta)).toEqual([6_000_000, -2_200_000, -3_800_000]);
    expect(entries.every((e) => e.refType === "ipo_bid" && e.refId === String(bid!.id) && e.cashDelta === 0)).toBe(true);
  });

  it("ipo 14: às 16h00 do fechamento, com a tarefa ainda sem rodar, registrar, editar e cancelar dão ipo_closed e a oferta fica como estava", async () => {
    const { account, walletId } = await player();
    await put(account, "FLA3", { quantity: 1500, maxPrice: 4000, expect: "new" });
    clock.set(CLOSES_AT);
    // A tarefa de fechar (A4) não rodou: a temporada ainda diz `ipo_open`.
    expect((await database.db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!.status).toBe("ipo_open");

    const attempts = [
      await put(account, "PAL3", { quantity: 10, maxPrice: 4000, expect: "new" }),
      await put(account, "FLA3", { quantity: 1000, maxPrice: 3800, expect: "existing" }),
      await del(account, "FLA3"),
    ];
    for (const res of attempts) {
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ipo_closed");
    }
    const bids = await bidsOf(walletId);
    expect(bids).toHaveLength(1);
    expect(bids[0]).toMatchObject({ quantity: 1500, maxPrice: 4000, reserved: 6_000_000, status: "active", updatedAt: DURING });
    expect((await walletRow(walletId)).reservedCash).toBe(6_000_000);
    expect(await reserveEntries(walletId)).toHaveLength(1);

    // Um minuto antes ainda aceitava.
    clock.set(new Date(CLOSES_AT.getTime() - 60_000));
    expect((await put(account, "FLA3", { quantity: 1000, maxPrice: 3800, expect: "existing" })).statusCode).toBe(200);
  });

  it("conta 5: token de e-mail não confirmado é recusado (403 email_not_confirmed) antes de chegar à oferta", async () => {
    const { account, walletId } = await player();
    const token = await tokenFor({ subject: account.subject, email: account.email, emailVerified: false, at: clock.now() });
    const putRes = await app.inject({
      method: "PUT",
      url: "/ipo/bids/FLA3",
      headers: bearer(token),
      payload: { quantity: 100, maxPrice: 4000, expect: "new" },
    });
    const delRes = await app.inject({ method: "DELETE", url: "/ipo/bids/FLA3", headers: bearer(token) });
    for (const res of [putRes, delRes]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("email_not_confirmed");
    }
    await expectNothingReserved(walletId);
  });

  it("sem login, 401", async () => {
    const res = await app.inject({ method: "PUT", url: "/ipo/bids/FLA3", payload: { quantity: 100, maxPrice: 4000, expect: "new" } });
    expect(res.statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: "/ipo/bids/FLA3" })).statusCode).toBe(401);
  });

  it("conta 13: conta criada com o IPO aberto (carteira aberta pelo POST /me) já faz oferta", async () => {
    const subject = "13131313-aaaa-4aaa-8aaa-131313131313";
    const email = "bruno13@exemplo.com";
    await database.db.insert(invites).values({ email, createdAt: clock.now() });
    const token = await tokenFor({ subject, email, at: clock.now() });
    const created = await app.inject({ method: "POST", url: "/me", headers: bearer(token), payload: { nickname: "bruno_13", acceptTerms: true } });
    expect(created.statusCode).toBe(201);
    const [user] = await database.db.select().from(users).where(eq(users.email, email));
    const [wallet] = await database.db.select().from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, user!.id)));
    expect(wallet).toMatchObject({ cash: INITIAL_CASH, entryMode: "ipo" });

    const res = await app.inject({
      method: "PUT",
      url: "/ipo/bids/FLA3",
      headers: bearer(token),
      payload: { quantity: 1500, maxPrice: 4000, expect: "new" },
    });
    expect(res.statusCode).toBe(200);
    expect(putBidResponseSchema.parse(res.json()).cash).toEqual({ total: INITIAL_CASH, reserved: 6_000_000, free: 4_000_000 });
  });

  it("admin: conta bloqueada não oferta (403 account_blocked) e nada é reservado", async () => {
    const { account, walletId } = await player({ status: "blocked" });
    const res = await put(account, "FLA3", { quantity: 100, maxPrice: 4000, expect: "new" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("account_blocked");
    await expectNothingReserved(walletId);
  });

  it("admin: caixa negativo (por estorno) não oferta (422 negative_cash) e nada é reservado", async () => {
    const { account, walletId } = await player();
    // O caixa só fica negativo por um estorno (`reversal`), como na correção de dividendos (F12).
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [walletId]);
      await post(tx, {
        walletId,
        at: clock.now(),
        kind: "reversal",
        clubId: clubIds.get("FLA3")!,
        cashDelta: -(INITIAL_CASH + 100),
        reason: "estorno do teste",
      });
    });
    expect((await walletRow(walletId)).cash).toBe(-100);
    const res = await put(account, "BOT3", { quantity: 1, maxPrice: 2000, expect: "new" });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("negative_cash");
    await expectNothingReserved(walletId);
  });

  it("ipo 26: conta sem carteira na temporada → 409 no_wallet, no PUT e no DELETE", async () => {
    const account = await createAccount(database.db);
    for (const res of [await put(account, "FLA3", { quantity: 100, maxPrice: 4000, expect: "new" }), await del(account, "FLA3")]) {
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("no_wallet");
    }
    expect(await database.db.select().from(wallets).where(eq(wallets.userId, account.id))).toHaveLength(0);
  });

  it("clube não listado na temporada (ou inexistente) → 404 club_not_listed", async () => {
    const { account, walletId } = await player();
    for (const ticker of ["SAO3", "ZZZ9"]) {
      const res = await put(account, ticker, { quantity: 100, maxPrice: 4000, expect: "new" });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("club_not_listed");
      expect((await del(account, ticker)).json().code).toBe("club_not_listed");
    }
    await expectNothingReserved(walletId);
  });

  it("antes da abertura (temporada em preparing) → 409 ipo_not_open, com ou sem carteira", async () => {
    const { account, walletId } = await player();
    const noWallet = await createAccount(database.db);
    await database.db.update(seasons).set({ status: "preparing" }).where(eq(seasons.id, seasonId));
    try {
      for (const res of [
        await put(account, "FLA3", { quantity: 100, maxPrice: 4000, expect: "new" }),
        await del(account, "FLA3"),
        await put(noWallet, "FLA3", { quantity: 100, maxPrice: 4000, expect: "new" }),
      ]) {
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("ipo_not_open");
      }
    } finally {
      await database.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, seasonId));
    }
    await expectNothingReserved(walletId);
  });

  it("depois da tarefa de fechar (ipo_closed) → 409 ipo_closed", async () => {
    const { account, walletId } = await player();
    await database.db.update(seasons).set({ status: "ipo_closed" }).where(eq(seasons.id, seasonId));
    try {
      const res = await put(account, "FLA3", { quantity: 100, maxPrice: 4000, expect: "new" });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ipo_closed");
    } finally {
      await database.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, seasonId));
    }
    await expectNothingReserved(walletId);
  });

  it("quantidade e preço inválidos pela rota → 400 invalid_quantity e invalid_price; corpo fora do contrato → invalid_input", async () => {
    const { account, walletId } = await player();
    for (const quantity of [0, -3, 1.5]) {
      const res = await put(account, "FLA3", { quantity, maxPrice: 4000, expect: "new" });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid_quantity");
    }
    for (const maxPrice of [0, -100, 4000.5]) {
      const res = await put(account, "FLA3", { quantity: 100, maxPrice, expect: "new" });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid_price");
    }
    for (const payload of [{ quantity: 100, maxPrice: 4000 }, { quantity: "100", maxPrice: 4000, expect: "new" }, { quantity: 1, maxPrice: 4000, expect: "talvez" }]) {
      const res = await put(account, "FLA3", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("invalid_input");
    }
    expect((await put(account, "fla3", { quantity: 100, maxPrice: 4000, expect: "new" })).json().code).toBe("invalid_input");
    await expectNothingReserved(walletId);
  });

  it("expect existing sem oferta e DELETE sem oferta → 404 bid_not_found", async () => {
    const { account, walletId } = await player();
    const res = await put(account, "FLA3", { quantity: 100, maxPrice: 4000, expect: "existing" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("bid_not_found");
    expect((await del(account, "FLA3")).json().code).toBe("bid_not_found");
    await expectNothingReserved(walletId);
    // Cancelada também não é oferta ativa.
    await put(account, "FLA3", { quantity: 100, maxPrice: 4000, expect: "new" });
    await del(account, "FLA3");
    expect((await del(account, "FLA3")).json().code).toBe("bid_not_found");
    expect((await put(account, "FLA3", { quantity: 100, maxPrice: 4000, expect: "existing" })).json().code).toBe("bid_not_found");
  });

  it("editar sem mudar nada não grava: o updated_at do desempate e o extrato ficam iguais", async () => {
    const { account, walletId } = await player();
    await put(account, "FLA3", { quantity: 1500, maxPrice: 4000, expect: "new" });
    clock.advance(10 * 60_000);
    const res = await put(account, "FLA3", { quantity: 1500, maxPrice: 4000, expect: "existing" });
    expect(res.statusCode).toBe(200);
    expect(putBidResponseSchema.parse(res.json()).bid).toEqual({ quantity: 1500, maxPrice: 4000, reserved: 6_000_000, updatedAt: DURING.toISOString() });
    expect((await bidsOf(walletId))[0]).toMatchObject({ updatedAt: DURING });
    expect(await reserveEntries(walletId)).toHaveLength(1);
  });

  it("editar só o preço acima do teto muda a oferta (e o desempate) sem mexer na reserva nem no extrato", async () => {
    const { account, walletId } = await player();
    await put(account, "FLA3", { quantity: 100, maxPrice: 9000, expect: "new" });
    clock.advance(60_000);
    const res = putBidResponseSchema.parse((await put(account, "FLA3", { quantity: 100, maxPrice: 9500, expect: "existing" })).json());
    expect(res.bid).toEqual({ quantity: 100, maxPrice: 9500, reserved: 707_700, updatedAt: clock.now().toISOString() });
    expect((await reserveEntries(walletId)).map((e) => e.reservedCashDelta)).toEqual([707_700]);
  });

  it("cancelar e registrar de novo reaproveita a mesma linha, ativa e com updated_at novo", async () => {
    const { account, walletId } = await player();
    await put(account, "FLA3", { quantity: 1500, maxPrice: 4000, expect: "new" });
    clock.advance(60_000);
    await del(account, "FLA3");
    const [cancelled] = await bidsOf(walletId);
    clock.advance(60_000);
    const res = await put(account, "FLA3", { quantity: 200, maxPrice: 5000, expect: "new" });
    expect(res.statusCode).toBe(200);
    const bids = await bidsOf(walletId);
    expect(bids).toHaveLength(1);
    expect(bids[0]).toMatchObject({
      id: cancelled!.id,
      status: "active",
      quantity: 200,
      maxPrice: 5000,
      reserved: 1_000_000,
      createdAt: DURING,
      updatedAt: clock.now(),
    });
    expect((await reserveEntries(walletId)).map((e) => e.reservedCashDelta)).toEqual([6_000_000, -6_000_000, 1_000_000]);
    expect((await walletRow(walletId)).reservedCash).toBe(1_000_000);
  });

  it("invariantes: carteiras iguais à soma do extrato e nenhuma reserva acima do caixa", async () => {
    await assertLedgerConsistent(database.db, seasonId);
  });
});
