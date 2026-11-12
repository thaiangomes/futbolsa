import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EntriesResponse, type EntryItem, entriesResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { wallets } from "../../src/infra/db/schema/index.js";
import { eq } from "drizzle-orm";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { insertTrade } from "../market/helpers.js";
import { AFTER_OPEN, applyMovements, creditPayout, insertPayout, ipoBuy, portfolioSeason, tradeBuy, tradeSell, type PortfolioSeason } from "./support.js";

// T6 e T22: GET /portfolio/entries (Carteira e gráficos 3, 4, 17, 19, 20, 21, 40 e 45).

const at = (iso: string) => new Date(iso);

describe("GET /portfolio/entries", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let fla: number;
  let pal: number;

  const player = async () => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    return { account, wallet: wallet! };
  };
  const list = async (account: TestAccount, query = ""): Promise<EntriesResponse> => {
    const res = await app.inject({ method: "GET", url: `/portfolio/entries${query}`, headers: bearer(await account.tokenWith({ at: clock.now() })) });
        expect(res.statusCode).toBe(200);
    return entriesResponseSchema.parse(res.json());
  };
  const all = async (account: TestAccount, query = ""): Promise<EntryItem[]> => {
    const items: EntryItem[] = [];
    let cursor: string | null = null;
    do {
      const page: EntriesResponse = await list(account, `?limit=5${query}${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
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

  it("sem login dá 401", async () => {
    expect((await app.inject({ method: "GET", url: "/portfolio/entries" })).statusCode).toBe(401);
  });

  it("carteira 3 e 4: o extrato mostra o realizado da venda, o caixa depois e o preço", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 1000, 3500));
    await applyMovements(database.db, ana.wallet, at("2027-04-06T13:00:00Z"), tradeBuy(fla, 500, 4100));
    await applyMovements(database.db, ana.wallet, at("2027-04-06T16:00:00Z"), tradeSell(fla, 300, 4500));
    const { items } = await list(ana.account);
    const sale = items[0]!;
    expect(sale).toMatchObject({ kind: "trade", group: "trade", quantity: -300, price: 4500, amount: 1_350_000, realized: 240_000, cashAfter: 5_800_000, club: { ticker: "FLA3" } });
    expect(items.map((i) => i.kind)).toEqual(["trade", "trade", "ipo_settle", "initial"]);
  });

  it("carteira 19: a soma do caixa de todas as linhas é o caixa total e o caixa depois da última é o caixa atual (sorteio)", async () => {
    const ana = await player();
    let seed = 11;
    const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let minute = 0;
    let shares = 0;
    for (let i = 0; i < 25; i++) {
      minute += 1 + Math.floor(next() * 30);
      const when = new Date(at("2027-04-06T11:00:00Z").getTime() + minute * 1000);
      const price = 3000 + Math.floor(next() * 1500);
      if (shares > 0 && next() < 0.4) {
        const q = 1 + Math.floor(next() * shares);
        shares -= q;
        await applyMovements(database.db, ana.wallet, when, tradeSell(fla, q, price));
      } else {
        const q = 1 + Math.floor(next() * 40);
        shares += q;
        await applyMovements(database.db, ana.wallet, when, tradeBuy(fla, q, price));
      }
      // linhas só de reserva ficam de fora e não mudam a soma
      if (i % 5 === 0) await applyMovements(database.db, ana.wallet, new Date(when.getTime() + 1), { kind: "order_reserve", clubId: pal, reservedCashDelta: 1000 });
    }
    const items = await all(ana.account);
    const [row] = await database.db.select().from(wallets).where(eq(wallets.id, ana.wallet));
    expect(items.reduce((sum, i) => sum + i.amount, 0)).toBe(row!.cash);
    expect(items[0]!.cashAfter).toBe(row!.cash);
    // 40: nenhuma linha só de reserva
    expect(items.every((i) => i.amount !== 0 || i.quantity !== 0)).toBe(true);
    expect(items.some((i) => i.kind === "order_reserve")).toBe(false);
  });

  it("paginação sem repetir nem pular linha com vários movimentos no mesmo instante", async () => {
    const ana = await player();
    const same = at("2027-04-06T12:00:00Z");
    for (let i = 0; i < 12; i++) await applyMovements(database.db, ana.wallet, same, tradeBuy(fla, 1, 3000 + i));
    const items = await all(ana.account);
    const ids = items.map((i) => i.id);
    expect(items).toHaveLength(13); // 12 compras e o `initial`
    expect(new Set(ids).size).toBe(13);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
  });

  it("filtros por clube e por grupo de tipo", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 100, 3500), ipoBuy(pal, 100, 4000));
    await applyMovements(database.db, ana.wallet, at("2027-04-06T13:00:00Z"), tradeBuy(pal, 10, 4100));
    expect((await all(ana.account, "&club=PAL3")).map((i) => i.kind)).toEqual(["trade", "ipo_settle"]);
    expect((await all(ana.account, "&kind=ipo")).map((i) => i.club?.ticker)).toEqual(["PAL3", "FLA3"]);
    expect((await all(ana.account, "&kind=entry")).map((i) => i.kind)).toEqual(["initial"]);
    expect(await all(ana.account, "&kind=dividend")).toEqual([]);
    const bad = await app.inject({ method: "GET", url: "/portfolio/entries?kind=xyz", headers: bearer(await ana.account.tokenWith({ at: clock.now() })) });
    expect(bad.statusCode).toBe(400);
  });

  it("carteira 17: o estorno aparece com o motivo, e o dividendo com o evento, o valor por ação e as ações", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(pal, 1200, 4000));
    const eventId = await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-6", perShare: 30, closedAt: at("2027-04-06T12:00:00Z"), status: "approved", reason: "3 pontos, rodada 5", holdings: [[ana.wallet, 1200]] });
    await creditPayout(database.db, eventId, ana.wallet, pal, at("2027-04-06T13:00:00Z"), 36_000);
    await applyMovements(database.db, ana.wallet, at("2027-04-06T14:00:00Z"), { kind: "reversal", clubId: pal, cashDelta: -6_000_000, reason: "erro de pontuação" });
    const items = await all(ana.account);
    const reversal = items.find((i) => i.kind === "reversal")!;
    expect(reversal).toMatchObject({ amount: -6_000_000, reason: "erro de pontuação", group: "dividend" });
    // estorno sem crédito ligado a um evento: só o motivo, sem valor por ação inventado
    expect(reversal.payout).toBeNull();
    expect(items.find((i) => i.kind === "dividend")!.payout).toEqual({ reason: "3 pontos, rodada 5", perShare: 30, shares: 1200 });
  });

  it("carteira 20: nenhum campo traz a contraparte (carteira, apelido, usuário ou casa)", async () => {
    const ana = await player();
    const bruno = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 100, 3500));
    await applyMovements(database.db, bruno.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 100, 3500));
    const tradeId = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: at("2027-04-06T13:00:00Z"), price: 4100, quantity: 10, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet });
    await applyMovements(database.db, ana.wallet, at("2027-04-06T13:00:00Z"), { ...tradeBuy(fla, 10, 4100), ref: { type: "trade", id: tradeId } });
    await applyMovements(database.db, bruno.wallet, at("2027-04-06T13:00:00Z"), { ...tradeSell(fla, 10, 4100), ref: { type: "trade", id: tradeId } });
    const res = await app.inject({ method: "GET", url: "/portfolio/entries", headers: bearer(await ana.account.tokenWith({ at: clock.now() })) });
    const text = res.body.toLowerCase();
    for (const secret of [bruno.account.nickname, bruno.account.id, bruno.account.email, "casa", "treasury", "bot", "counterparty", "contraparte", "seller", "buyer", "wallet"]) {
      expect(text, `o extrato mostrou "${secret}"`).not.toContain(secret.toLowerCase());
    }
    // nenhuma chave de carteira, usuário, ordem ou negócio de outra pessoa
    const keys = new Set<string>();
    const walk = (v: unknown) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
    walk(res.json());
    expect([...keys].filter((k) => /wallet|user|order|trade|counter|buyer|seller/i.test(k))).toEqual([]);
    // e a carteira de Bruno só mostra o que é dele
    expect((await list(bruno.account)).items[0]).toMatchObject({ quantity: -10 });
  });

  it("em leilão: a linha do negócio que saiu num leilão traz a marca; o negócio comum não", async () => {
    const ana = await player();
    const bruno = await player();
    const auctionTrade = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: at("2027-04-06T13:00:00Z"), price: 4100, quantity: 5, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet, inAuction: true });
    const plainTrade = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: at("2027-04-06T14:00:00Z"), price: 4100, quantity: 5, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet });
    await applyMovements(database.db, ana.wallet, at("2027-04-06T13:00:00Z"), { ...tradeBuy(fla, 5, 4100), ref: { type: "trade", id: auctionTrade } });
    await applyMovements(database.db, ana.wallet, at("2027-04-06T14:00:00Z"), { ...tradeBuy(fla, 5, 4100), ref: { type: "trade", id: plainTrade } });
    const items = (await list(ana.account)).items;
    expect(items.map((i) => i.inAuction)).toEqual([false, true, false]);
  });
});
