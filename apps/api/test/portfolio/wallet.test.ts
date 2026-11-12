import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type WalletView, walletViewSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { meChannel, EventBus } from "../../src/infra/realtime/index.js";
import { seasonClubs, seasons, users } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { EquityAt } from "../../src/modules/portfolio/valuation/equity-at.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { AFTER_OPEN, applyMovements, creditPayout, insertPayout, ipoBuy, portfolioSeason, setPrice, tradeBuy, tradeSell, type PortfolioSeason } from "./support.js";

// T5 e T22: GET /portfolio (Carteira e gráficos 1 a 17, 38 e 45).

const at = (iso: string) => new Date(iso);

describe("GET /portfolio", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let fla: number;
  let pal: number;

  const player = async (opts: { status?: "active" | "blocked" } = {}) => {
    const account = await createAccount(database.db, { status: opts.status });
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    return { account, wallet: wallet! };
  };
  const get = async (account: TestAccount): Promise<WalletView> => {
    const res = await app.inject({ method: "GET", url: "/portfolio", headers: bearer(await account.tokenWith({ at: clock.now() })) });
    expect(res.statusCode).toBe(200);
    return walletViewSchema.parse(res.json());
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    pal = s.clubIds.get("PAL3")!;
  });
  afterAll(async () => {
    await app.close();
  });

  it("sem login dá 401; quem ainda não entrou na temporada dá 404", async () => {
    expect((await app.inject({ method: "GET", url: "/portfolio" })).statusCode).toBe(401);
    const account = await createAccount(database.db);
    const res = await app.inject({ method: "GET", url: "/portfolio", headers: bearer(await account.tokenWith({ at: clock.now() })) });
    expect(res.statusCode).toBe(404);
  });

  it("carteira 1 a 5, 9, 11 a 14: custo, preço médio, realizado, reservado, patrimônio e resultado por clube", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 1000, 3500));
    await setPrice(database.db, s, "FLA3", at("2027-04-05T13:00:00Z"), 3500);
    await applyMovements(database.db, ana.wallet, at("2027-04-06T13:00:00Z"), tradeBuy(fla, 500, 4100));
    await setPrice(database.db, s, "FLA3", at("2027-04-06T13:00:00Z"), 4100);
    await applyMovements(database.db, ana.wallet, at("2027-04-06T16:00:00Z"), tradeSell(fla, 300, 4500));
    await setPrice(database.db, s, "FLA3", at("2027-04-06T16:00:00Z"), 4500);
    // R$ 4.000,00 reservados numa ordem de compra e 500 ações presas numa de venda
    await applyMovements(database.db, ana.wallet, at("2027-04-06T17:00:00Z"), { kind: "order_reserve", clubId: pal, reservedCashDelta: 400_000 });
    await applyMovements(database.db, ana.wallet, at("2027-04-06T17:01:00Z"), { kind: "order_reserve", clubId: fla, reservedSharesDelta: 500 });

    const view = await get(ana.account);
    expect(view.cash).toEqual({ total: 5_800_000, reserved: 400_000, free: 5_400_000 });
    expect(view.negativeCash).toBe(false);
    expect(view.stocksValue).toBe(5_400_000);
    expect(view.equity).toBe(11_200_000);
    expect(view.returnBp).toBe(1200);
    expect(view.positions).toHaveLength(1);
    expect(view.positions[0]).toMatchObject({
      club: { ticker: "FLA3" },
      shares: 1200,
      inOrders: 500,
      free: 700,
      averagePrice: 3700,
      cost: 4_440_000,
      price: 4500,
      marketValue: 5_400_000,
      unrealized: 960_000,
      unrealizedPermille: 216,
      shareOfEquityPermille: 482,
      auction: null,
    });
    // critério 14: a soma dos resultados é o patrimônio menos R$ 100.000,00
    expect(view.results.reduce((sum, r) => sum + r.total, 0)).toBe(view.equity - 10_000_000);
    expect(view.results[0]).toMatchObject({ club: { ticker: "FLA3" }, realized: 240_000, unrealized: 960_000, total: 1_200_000 });
  });

  it("carteira 6 e 8: o dividendo sobe o caixa e os dividendos sem mexer no custo; zerar tira a linha e mantém o resultado", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(pal, 1200, 4000));
    const eventId = await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-8", perShare: 30, closedAt: at("2027-04-06T12:00:00Z"), status: "approved", holdings: [[ana.wallet, 1200]] });
    await creditPayout(database.db, eventId, ana.wallet, pal, at("2027-04-06T13:00:00Z"), 36_000);
    const before = await get(ana.account);
    expect(before.positions[0]).toMatchObject({ dividends: 36_000, cost: 4_800_000, receivable: 0 });
    expect(before.cash.total).toBe(10_000_000 - 4_800_000 + 36_000);
    await applyMovements(database.db, ana.wallet, at("2027-04-06T14:00:00Z"), tradeSell(pal, 1200, 4000));
    const after = await get(ana.account);
    expect(after.positions).toEqual([]);
    expect(after.results[0]).toMatchObject({ club: { ticker: "PAL3" }, dividends: 36_000, realized: 0, total: 36_000 });
  });

  it("carteira 10 e 16: clube sem negócio usa o preço do IPO; só caixa tem R$ 100.000,00 e nenhuma posição", async () => {
    const cashOnly = await player();
    expect(await get(cashOnly.account)).toMatchObject({ equity: 10_000_000, returnBp: 0, positions: [], results: [], stocksValue: 0 });
    const holder = await player();
    await applyMovements(database.db, holder.wallet, at("2027-04-06T12:00:00Z"), ipoBuy(s.clubIds.get("COR3")!, 100, 4000));
    const view = await get(holder.account);
    expect(view.positions[0]).toMatchObject({ price: 4000, marketValue: 400_000, unrealized: 0 });
    expect(view.equity).toBe(10_000_000);
  });

  it("carteira 17: o caixa negativo por estorno aparece em destaque e soma no patrimônio", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-06T12:00:00Z"), { kind: "reversal", clubId: fla, cashDelta: -10_025_000, reason: "correção" });
    const view = await get(ana.account);
    expect(view.negativeCash).toBe(true);
    expect(view.cash).toEqual({ total: -25_000, reserved: 0, free: -25_000 });
    expect(view.equity).toBe(-25_000);
    expect(view.positions).toEqual([]);
  });

  it("carteira 38: R$ 360,00 a receber contam no patrimônio e, aprovado e creditado, o patrimônio não muda", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(pal, 1200, 4000));
    const eventId = await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-38", perShare: 30, closedAt: at("2027-04-06T12:00:00Z"), holdings: [[ana.wallet, 1200]] });
    const pending = await get(ana.account);
    expect(pending.receivable).toBe(36_000);
    expect(pending.positions[0]!.receivable).toBe(36_000);
    expect(pending.equity).toBe(10_000_000 + 36_000);
    await creditPayout(database.db, eventId, ana.wallet, pal, at("2027-04-06T14:00:00Z"), 36_000);
    const paid = await get(ana.account);
    expect(paid.receivable).toBe(0);
    expect(paid.cash.total).toBe(10_000_000 - 4_800_000 + 36_000);
    expect(paid.equity).toBe(pending.equity);
  });

  it("recompra fechada: as ações valem R$ 0,00 e conta só a recompra a receber", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(pal, 100, 4000));
    await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "buyback-v", kind: "buyback", perShare: 1935, closedAt: at("2027-04-06T10:00:00Z"), holdings: [[ana.wallet, 100]] });
    await database.db.update(seasons).set({ tradingEndedAt: at("2027-04-06T10:00:00Z") }).where(eq(seasons.id, s.seasonId));
    const view = await get(ana.account);
    await database.db.update(seasons).set({ tradingEndedAt: null }).where(eq(seasons.id, s.seasonId));
    expect(view).toMatchObject({ buybackClosed: true, stocksValue: 0, receivable: 193_500, equity: 10_000_000 - 400_000 + 193_500 });
  });

  it("o patrimônio do estado atual é igual ao do histórico em 'agora' (sorteio de movimentos)", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 700, 3500), ipoBuy(pal, 300, 4000));
    await setPrice(database.db, s, "FLA3", at("2027-04-06T11:00:00Z"), 3900);
    await applyMovements(database.db, ana.wallet, at("2027-04-06T11:30:00Z"), tradeSell(fla, 200, 3900));
    await insertPayout(database.db, { seasonId: s.seasonId, clubId: fla }, { key: "pts-eq", perShare: 25, closedAt: at("2027-04-06T12:00:00Z"), holdings: [[ana.wallet, 500]] });
    const view = await get(ana.account);
    const history = await withTransaction(database.db, async (tx) => (await EquityAt.forSeason(tx, s.seasonId, clock.now(), { wallets: [ana.wallet] })).get(ana.wallet)!);
    expect(view.equity).toBe(history.equity);
    expect(view.receivable).toBe(history.receivable);
    expect(view.cash.total).toBe(history.cash);
  });

  it("a conta bloqueada lê a própria carteira", async () => {
    const blocked = await player({ status: "blocked" });
    expect((await get(blocked.account)).equity).toBe(10_000_000);
  });

  it("o seq do canal me vem junto: um evento publicado antes da leitura entra na conta", async () => {
    const ana = await player();
    const bus = app.get(EventBus);
    const before = (await get(ana.account)).seq;
    bus.publish(meChannel(ana.account.id), "wallet.changed", { cash: 1, reserved: 0, club: null, version: 1 });
    expect((await get(ana.account)).seq).toBe(before + 1);
  });

  it("em leilão: a posição do clube em leilão traz auction.until; fora dele, null; parado pela suspensão, until nulo; o patrimônio não muda", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 100, 4000), ipoBuy(pal, 100, 4000));
    const normal = await get(ana.account);
    expect(normal.positions.every((p) => p.auction === null)).toBe(true);

    const until = at("2027-04-06T18:40:00Z");
    await database.db.update(seasonClubs).set({ auctionOpenedAt: at("2027-04-06T18:30:00Z"), auctionUntil: until }).where(eq(seasonClubs.clubId, fla));
    await database.db.update(seasonClubs).set({ auctionOpenedAt: at("2027-04-06T18:30:00Z"), auctionUntil: null }).where(eq(seasonClubs.clubId, pal));
    const auction = await get(ana.account);
    expect(auction.positions.find((p) => p.club.ticker === "FLA3")!.auction).toEqual({ until: until.toISOString() });
    expect(auction.positions.find((p) => p.club.ticker === "PAL3")!.auction).toEqual({ until: null });
    // o preço exibido fica parado: o valor a mercado e o patrimônio são os de antes do leilão
    expect(auction.equity).toBe(normal.equity);
    expect(auction.positions.map((p) => p.marketValue)).toEqual(normal.positions.map((p) => p.marketValue));

    await database.db.update(seasonClubs).set({ auctionOpenedAt: null, auctionUntil: null }).where(eq(seasonClubs.seasonId, s.seasonId));
    expect((await get(ana.account)).positions.every((p) => p.auction === null)).toBe(true);
  });

  it("o JSON da carteira não traz id de usuário nem de carteira", async () => {
    const ana = await player();
    const res = await app.inject({ method: "GET", url: "/portfolio", headers: bearer(await ana.account.tokenWith({ at: clock.now() })) });
    const text = res.body;
    expect(text).not.toContain(ana.account.id);
    expect(text).not.toContain(ana.account.email);
    expect(await database.db.select().from(users).where(eq(users.id, ana.account.id))).toHaveLength(1);
  });
});
