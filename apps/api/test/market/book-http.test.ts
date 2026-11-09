import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookViewSchema, clubListSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { positions, seasonClubs, seasons, wallets } from "../../src/infra/db/schema/index.js";
import { EventBus } from "../../src/infra/realtime/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { insertMatch, insertOpenOrder, insertTrade, marketSeason, tradeWallets, type MarketSeason } from "./helpers.js";

// T8 e a parte de leitura da L8 do Plano do livro de ofertas e formador: GET /clubs/:ticker/book e GET /clubs.

describe("livro e lista de clubes (HTTP)", () => {
  const database = useTestDatabase(12);
  // 2027-04-06 15h de Brasília
  const clock = new FixedClock(new Date("2027-04-06T18:00:00Z"));
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let ana: TestAccount;
  let anaToken: string;
  let anaWallet: number;
  let others: { buyer: number; seller: number };

  const get = (url: string, token?: string) => app.inject({ method: "GET", url, ...(token ? { headers: bearer(token) } : {}) });
  const id = (t: string) => s.clubIds.get(t)!;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db);
    ana = await createAccount(database.db);
    // o token vale a partir do instante do relógio de teste (o padrão é 2027-04-01)
    anaToken = await ana.tokenWith({ at: clock.now() });
    [anaWallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: ana.id }], 1_000_000);
    others = await tradeWallets(database.db, s.seasonId);
    // negócios: FLA3 a R$ 40,00 antes das 0h de Brasília (03h UTC) e a R$ 42,00 hoje
    await insertTrade(database.db, { seasonId: s.seasonId, clubId: id("FLA3"), at: new Date("2027-04-06T02:00:00Z"), price: 4000, quantity: 10, buyerWalletId: others.buyer, sellerWalletId: others.seller });
    await insertTrade(database.db, { seasonId: s.seasonId, clubId: id("FLA3"), at: new Date("2027-04-06T12:00:00Z"), price: 4200, quantity: 5, buyerWalletId: others.buyer, sellerWalletId: others.seller });
    await database.db.update(seasonClubs).set({ lastPrice: 4200 }).where(eq(seasonClubs.clubId, id("FLA3")));
    // livro: 7 vendas em preços diferentes (uma de Ana) e duas compras
    for (let i = 0; i < 6; i++) await insertOpenOrder(database.db, { seasonId: s.seasonId, clubId: id("FLA3"), walletId: others.seller, side: "sell", price: 4300 + i * 10, quantity: 10 + i });
    await insertOpenOrder(database.db, { seasonId: s.seasonId, clubId: id("FLA3"), walletId: anaWallet, side: "sell", price: 4300, quantity: 5 });
    await insertOpenOrder(database.db, { seasonId: s.seasonId, clubId: id("FLA3"), walletId: others.buyer, side: "buy", price: 4100, quantity: 20 });
    // posição de Ana em FLA3: 100 ações, 5 presas na venda
    await database.db.update(wallets).set({ reservedCash: 100_000 }).where(eq(wallets.id, anaWallet));
    await database.db.insert(positions).values({ walletId: anaWallet, clubId: id("FLA3"), shares: 100, reservedShares: 5 });
  });
  afterAll(() => app.close());

  it("livro 18 e 19: o visitante recebe livro de 5 níveis, negócios, preço e variação, sem faixa nem saldo e sem dono", async () => {
    const res = await get("/clubs/FLA3/book");
    expect(res.statusCode).toBe(200);
    const view = bookViewSchema.parse(res.json());
    expect(view.me).toBeNull();
    expect(view.asks).toHaveLength(5);
    expect(view.asks[0]).toEqual({ price: 4300, quantity: 15, orders: 2 }); // a venda de Bruno e a de Ana no mesmo preço, somadas
    expect(view.bids).toEqual([{ price: 4100, quantity: 20, orders: 1 }]);
    expect(view.trades.map((t) => t.price)).toEqual([4200, 4000]);
    expect(JSON.stringify(res.json())).not.toMatch(/wallet|buyer|seller|email|nickname|house/i);
  });

  it("livro 20: R$ 40,00 às 0h e R$ 42,00 agora dão +5,00% (500 centésimos de ponto)", async () => {
    const view = bookViewSchema.parse((await get("/clubs/FLA3/book")).json());
    expect(view.price).toEqual({ displayed: 4200, open: 4000, changeBp: 500 });
  });

  it("livro 6 e conta 11: logado recebe a faixa de 20% e o caixa e as ações livres, e mais nada de ninguém", async () => {
    const res = await get("/clubs/FLA3/book", anaToken);
    const view = bookViewSchema.parse(res.json());
    // faixa em volta de R$ 42,00, caixa livre = total − reservado, ações livres = posição − presas
    expect(view.me).toEqual({ band: { min: 3360, max: 5040 }, freeCash: 900_000, freeShares: 95 });
    expect(JSON.stringify(res.json())).not.toContain(ana.email);
  });

  it("logado sem posição no clube: zero ações livres", async () => {
    const res = await get("/clubs/PAL3/book", anaToken);
    expect(bookViewSchema.parse(res.json()).me).toMatchObject({ freeShares: 0, freeCash: 900_000 });
  });

  it("o seq do canal do clube é lido antes do banco: um evento publicado depois não entra na resposta", async () => {
    const bus = app.get(EventBus, { strict: false });
    bus.publish("club:FLA3", "match_mode", { active: false });
    const before = bus.currentSeq("club:FLA3");
    const view = bookViewSchema.parse((await get("/clubs/FLA3/book")).json());
    expect(view.seq).toBe(before);
    bus.publish("club:FLA3", "match_mode", { active: false });
    expect(bus.currentSeq("club:FLA3")).toBe(before + 1);
  });

  it("ticker não listado dá 404, e ticker de formato inválido, 400", async () => {
    expect((await get("/clubs/ZZZ9/book")).statusCode).toBe(404);
    expect((await get("/clubs/fla3/book")).statusCode).toBe(400);
  });

  it("livro 26: o modo de jogo aparece quando o clube está em jogo e some com o placar", async () => {
    const matchId = await insertMatch(database.db, { seasonId: s.seasonId, homeClubId: id("FLA3"), awayClubId: id("PAL3"), kickoff: new Date("2027-04-06T17:00:00Z") });
    expect(bookViewSchema.parse((await get("/clubs/FLA3/book")).json()).matchMode).toBe(true);
    expect(bookViewSchema.parse((await get("/clubs/SPT3/book")).json()).matchMode).toBe(false);
    await database.db.execute(sql`update futbolsa.matches set status = 'finished', finished_at = '2027-04-06T17:55:00Z' where id = ${matchId}`);
    expect(bookViewSchema.parse((await get("/clubs/FLA3/book")).json()).matchMode).toBe(false);
  });

  it("o leilão aparece com a hora do fim; parado pela suspensão, com `until` vazio; fora de leilão, nulo", async () => {
    const where = eq(seasonClubs.clubId, id("PAL3"));
    expect(bookViewSchema.parse((await get("/clubs/PAL3/book")).json()).auction).toBeNull();
    await database.db.update(seasonClubs).set({ auctionOpenedAt: new Date("2027-04-06T17:00:00Z"), auctionUntil: new Date("2027-04-06T20:00:00Z") }).where(where);
    expect(bookViewSchema.parse((await get("/clubs/PAL3/book")).json()).auction).toEqual({ until: "2027-04-06T20:00:00.000Z" });
    await database.db.update(seasonClubs).set({ auctionUntil: null, suspendedReason: "Placar errado" }).where(where);
    const parado = bookViewSchema.parse((await get("/clubs/PAL3/book")).json());
    expect(parado.auction).toEqual({ until: null });
    expect(parado.market).toEqual({ state: "suspended", opensAt: "2027-04-05T13:00:00.000Z", reason: "Placar errado" });
    await database.db.update(seasonClubs).set({ auctionOpenedAt: null, suspendedReason: null }).where(where);
  });

  it("estados do mercado: aberto, ainda não aberto, suspenso (mercado todo) e encerrado", async () => {
    const market = async () => bookViewSchema.parse((await get("/clubs/COR3/book")).json()).market;
    expect(await market()).toEqual({ state: "open", opensAt: "2027-04-05T13:00:00.000Z", reason: null });
    await database.db.update(seasons).set({ suspendedReason: "Manutenção" }).where(eq(seasons.id, s.seasonId));
    expect(await market()).toMatchObject({ state: "suspended", reason: "Manutenção" });
    await database.db.update(seasons).set({ suspendedReason: null, status: "ipo_closed" }).where(eq(seasons.id, s.seasonId));
    expect(await market()).toMatchObject({ state: "not_open", opensAt: "2027-04-05T13:00:00.000Z" });
    await database.db.update(seasons).set({ status: "trading_ended", tradingEndedAt: new Date("2027-04-06T17:00:00Z") }).where(eq(seasons.id, s.seasonId));
    expect(await market()).toMatchObject({ state: "ended" });
    await database.db.update(seasons).set({ status: "trading", tradingEndedAt: null }).where(eq(seasons.id, s.seasonId));
  });

  it("GET /clubs: a lista pública com preço, variação, jogo, leilão e suspensão, e o seq do canal prices lido antes", async () => {
    const bus = app.get(EventBus, { strict: false });
    bus.publish("prices", "price", { ticker: "FLA3", price: 4200, changeBp: 500, auction: null });
    const before = bus.currentSeq("prices");
    await database.db.update(seasonClubs).set({ suspendedReason: "Motivo X" }).where(eq(seasonClubs.clubId, id("SPT3")));
    await database.db.update(seasonClubs).set({ auctionOpenedAt: new Date("2027-04-06T17:30:00Z"), auctionUntil: new Date("2027-04-06T20:30:00Z") }).where(eq(seasonClubs.clubId, id("COR3")));
    await insertMatch(database.db, { seasonId: s.seasonId, homeClubId: id("PAL3"), awayClubId: id("SPT3"), kickoff: new Date("2027-04-06T17:30:00Z"), round: 2 });
    const res = await get("/clubs");
    expect(res.statusCode).toBe(200);
    const list = clubListSchema.parse(res.json());
    expect(list.seq).toBe(before);
    expect(list.clubs.map((c) => c.ticker).sort()).toEqual(["COR3", "FLA3", "PAL3", "SPT3"]);
    const by = (t: string) => list.clubs.find((c) => c.ticker === t)!;
    expect(by("FLA3")).toMatchObject({ name: "Flamengo", division: "A", price: 4200, changeBp: 500 });
    expect(by("PAL3")).toMatchObject({ price: 4000, changeBp: 0, matchMode: true });
    expect(by("SPT3").suspended).toEqual({ reason: "Motivo X" });
    expect(by("COR3").auction).toEqual({ until: "2027-04-06T20:30:00.000Z" });
    expect(list.market.state).toBe("open");
    expect(JSON.stringify(res.json())).not.toMatch(/wallet|email|nickname/i);
  });
});
