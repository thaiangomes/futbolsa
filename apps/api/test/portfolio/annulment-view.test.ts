import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entriesResponseSchema, myTradesResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { tradeAnnulments } from "../../src/infra/db/schema/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { insertTrade } from "../market/helpers.js";
import { AFTER_OPEN, applyMovements, ipoBuy, portfolioSeason, type PortfolioSeason } from "./support.js";

// F10, T21 (acréscimo da F14): o extrato mostra o negócio anulado (mesmo sem caixa nem ações) e os marcadores dos meus
// negócios saem sem ele (Admin 42 e 43).

const at = (iso: string) => new Date(iso);

describe("extrato e marcadores com negócio anulado", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let fla: number;

  const player = async () => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    return { account, wallet: wallet! };
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
  });
  afterAll(() => app?.close());

  it("admin 43: a linha do desfazer aparece no extrato, mesmo sem caixa nem ações, com o motivo; o negócio original vem marcado; o negócio com outro jogador não", async () => {
    const ana = await player();
    const bruno = await player();
    const carla = await player();
    await applyMovements(database.db, bruno.wallet, at("2027-04-05T14:00:00Z"), ipoBuy(fla, 10, 4000));
    const t1 = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: at("2027-04-06T13:00:00Z"), price: 4400, priceBefore: 4000, quantity: 2, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet });
    const t2 = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: at("2027-04-06T14:00:00Z"), price: 4100, quantity: 1, buyerWalletId: ana.wallet, sellerWalletId: carla.wallet });
    const buy = (id: number, qty: number, price: number) => ({ kind: "trade" as const, clubId: fla, sharesDelta: qty, cashDelta: -qty * price, price, costBasis: "purchase" as const, ref: { type: "trade", id } });
    await applyMovements(database.db, ana.wallet, at("2027-04-06T13:00:00Z"), buy(t1, 2, 4400));
    await applyMovements(database.db, ana.wallet, at("2027-04-06T14:00:00Z"), buy(t2, 1, 4100));
    // Ana já não tinha as ações do primeiro negócio: falta total, a linha do desfazer não mexe em caixa nem ações
    await applyMovements(database.db, ana.wallet, at("2027-04-07T10:00:00Z"), { kind: "trade_annulled", clubId: fla, sharesDelta: 0, cashDelta: 0, price: 4400, ref: { type: "trade", id: t1 }, reason: "preços combinados", annulled: { cost: 12_300, realized: 0 } });
    await database.db.insert(tradeAnnulments).values({ tradeId: t1, caseId: 1, at: at("2027-04-07T10:00:00Z"), sharesShort: 2 });

    const res = await app.inject({ method: "GET", url: "/portfolio/entries", headers: bearer(await ana.account.tokenWith({ at: clock.now() })) });
    expect(res.statusCode).toBe(200);
    const items = entriesResponseSchema.parse(res.json()).items;
    const annulled = items.find((i) => i.kind === "trade_annulled");
    expect(annulled).toMatchObject({ quantity: 0, amount: 0, reason: "preços combinados", group: "trade" });
    expect(items.find((i) => i.kind === "trade" && i.price === 4400)!.annulled).toBe(true);
    expect(items.find((i) => i.kind === "trade" && i.price === 4100)!.annulled).toBe(false);
    expect(JSON.stringify(items)).not.toMatch(/Bruno|counterpart/i);
  });

  it("admin 42: os marcadores dos meus negócios saem sem o negócio anulado por inteiro", async () => {
    const ana = await player();
    const bruno = await player();
    await applyMovements(database.db, bruno.wallet, at("2027-04-05T14:00:00Z"), ipoBuy(fla, 10, 4000));
    const t1 = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: at("2027-04-06T13:00:00Z"), price: 4400, priceBefore: 4000, quantity: 1, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet });
    const t2 = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: at("2027-04-06T14:00:00Z"), price: 4500, priceBefore: 4400, quantity: 1, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet });
    for (const [id, when, price] of [[t1, "2027-04-06T13:00:00Z", 4400], [t2, "2027-04-06T14:00:00Z", 4500]] as const) {
      await applyMovements(database.db, ana.wallet, at(when), { kind: "trade", clubId: fla, sharesDelta: 1, cashDelta: -price, price, costBasis: "purchase", ref: { type: "trade", id } });
    }
    await database.db.insert(tradeAnnulments).values({ tradeId: t1, caseId: 1, at: at("2027-04-07T10:00:00Z"), sharesReturned: 1, cashReturned: 4400 });
    const res = await app.inject({ method: "GET", url: "/portfolio/clubs/FLA3/trades?range=30d", headers: bearer(await ana.account.tokenWith({ at: clock.now() })) });
    expect(res.statusCode, res.body).toBe(200);
    const trades = myTradesResponseSchema.parse(res.json()).trades;
    expect(trades.map((t) => t.price)).toEqual([4500]);
  });
});
