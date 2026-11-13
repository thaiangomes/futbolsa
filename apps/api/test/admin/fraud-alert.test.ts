import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fraudCasesResponseSchema, overviewSchema, type FraudCaseItem } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { fraudCases, tradeAnnulments } from "../../src/infra/db/schema/index.js";
import { AlertScan } from "../../src/modules/admin/fraud/alert-scan.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { insertTrade, marketSeason, type MarketSeason } from "../market/helpers.js";
import { openBot, openTreasury } from "../market/order-helpers.js";

// F14, T21: a tarefa do alerta e a lista de casos (Admin 39, 40 e 31). Os negócios não se apagam, então cada teste
// usa o seu par de contas novo e olha só os casos dele.

describe("alerta de trapaça", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  const HOUR = 3_600_000;
  let app: NestFastifyApplication;
  let scan: AlertScan;
  let s: MarketSeason;
  let admin: TestAccount;
  let house: number;
  let spt: number;
  let cor: number;
  let n = 0;

  const ago = (hours: number) => new Date(clock.now().getTime() - hours * HOUR);
  const player = async (nickname: string) => {
    const account = await createAccount(database.db, { nickname });
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    return { account, wallet: wallet! };
  };
  /** Um par novo e a função que grava um negócio suspeito dele: 1 ação, 10% acima do preço anterior, Ana compra. */
  const pair = async () => {
    n += 1;
    const ana = await player(`Ana${n}`);
    const bruno = await player(`Bruno${n}`);
    const suspect = (hoursAgo: number, over: Partial<Parameters<typeof insertTrade>[1]> = {}) =>
      insertTrade(database.db, {
        seasonId: s.seasonId,
        clubId: spt,
        at: ago(hoursAgo),
        price: 770,
        priceBefore: 700,
        quantity: 1,
        buyerWalletId: ana.wallet,
        sellerWalletId: bruno.wallet,
        ...over,
      });
    const mine = async (query = ""): Promise<FraudCaseItem[]> => {
      const res = await app.inject({ method: "GET", url: `/admin/fraud/cases${query}`, headers: bearer(admin.token) });
      expect(res.statusCode, res.body).toBe(200);
      return fraudCasesResponseSchema.parse(res.json()).cases.filter((c) => c.parties.some((p) => p.walletId === ana.wallet || p.walletId === bruno.wallet));
    };
    return { ana, bruno, suspect, mine };
  };
  const overview = async () => overviewSchema.parse((await app.inject({ method: "GET", url: "/admin/overview", headers: bearer(admin.token) })).json());

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    scan = app.get(AlertScan);
    s = await marketSeason(database.db);
    spt = s.clubIds.get("SPT3")!;
    cor = s.clubIds.get("COR3")!;
    admin = await createAccount(database.db, { role: "admin" });
    house = await openTreasury(database.db, s.seasonId);
  });
  afterAll(async () => {
    await app.close();
  });

  it("admin 39: no 3º negócio o alerta aparece nas pendências na rodada seguinte da tarefa e nenhum dos dois vê nada", async () => {
    const p = await pair();
    const before = await app.inject({ method: "GET", url: "/me", headers: bearer(p.ana.account.token) });
    await p.suspect(30);
    await p.suspect(20);
    expect(await scan.scan()).toEqual({ created: 0, grown: 0 });
    expect(await p.mine()).toEqual([]);
    expect((await overview()).openFraudCases).toBe(0);

    await p.suspect(10);
    expect(await scan.scan()).toEqual({ created: 1, grown: 0 });
    const cases = await p.mine();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ origin: "alert", status: "open", ticker: "SPT3", tradeCount: 3, suspiciousCount: 3 });
    expect(cases[0]!.parties.map((x) => x.label).sort()).toEqual([`Ana${n}`, `Bruno${n}`]);
    expect((await overview()).openFraudCases).toBe(1);

    // o jogador não vê nada: GET /me igual e nenhuma rota fora de /admin conhece o caso
    const after = await app.inject({ method: "GET", url: "/me", headers: bearer(p.ana.account.token) });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(before.json());
    const asPlayer = await app.inject({ method: "GET", url: "/admin/fraud/cases", headers: bearer(p.ana.account.token) });
    expect(asPlayer.statusCode).toBe(403);
  });

  it("admin 40: 15 negócios de mais de 10 ações ou com menos de 5% não dão alerta", async () => {
    const p = await pair();
    for (let i = 0; i < 8; i++) await p.suspect(40 + i, { quantity: 11, clubId: cor });
    for (let i = 0; i < 7; i++) await p.suspect(30 + i, { clubId: cor, price: 710 });
    expect(await scan.scan()).toEqual({ created: 0, grown: 0 });
    expect(await p.mine()).toEqual([]);
  });

  it("negócio em leilão conta, o 4º suspeito entra no caso aberto e rodar duas vezes não duplica", async () => {
    const p = await pair();
    await p.suspect(30);
    await p.suspect(20, { inAuction: true });
    await p.suspect(10);
    expect(await scan.scan()).toEqual({ created: 1, grown: 0 });
    expect(await scan.scan()).toEqual({ created: 0, grown: 0 });
    await p.suspect(5);
    expect(await scan.scan()).toEqual({ created: 0, grown: 1 });
    const cases = await p.mine();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ tradeCount: 4, suspiciousCount: 4 });
  });

  it("a casa não entra e o par invertido é o mesmo par", async () => {
    const p = await pair();
    for (const h of [30, 20, 10]) await p.suspect(h, { sellerWalletId: house, withHouse: true });
    expect(await scan.scan()).toEqual({ created: 0, grown: 0 });

    await p.suspect(30, { clubId: cor });
    await p.suspect(20, { clubId: cor, buyerWalletId: p.bruno.wallet, sellerWalletId: p.ana.wallet });
    await p.suspect(10, { clubId: cor });
    expect(await scan.scan()).toEqual({ created: 1, grown: 0 });
    expect(await p.mine()).toHaveLength(1);
  });

  it("bot e jogador dão alerta", async () => {
    const p = await pair();
    const botWallet = await openBot(database.db, s.seasonId, 1_000_000);
    for (const h of [9, 8, 7]) await p.suspect(h, { sellerWalletId: botWallet });
    expect(await scan.scan()).toEqual({ created: 1, grown: 0 });
    const cases = await p.mine();
    expect(cases).toHaveLength(1);
    expect(cases[0]!.parties.some((x) => x.kind === "bot" && x.label.startsWith("bot "))).toBe(true);
  });

  it("depois de descartado, os mesmos 3 não dão alerta e 3 novos dão", async () => {
    const p = await pair();
    await p.suspect(30);
    await p.suspect(20);
    await p.suspect(10);
    expect((await scan.scan()).created).toBe(1);
    const [first] = await p.mine();
    await database.db.update(fraudCases).set({ status: "dismissed", decidedAt: clock.now() }).where(eq(fraudCases.id, first!.id));
    expect(await scan.scan()).toEqual({ created: 0, grown: 0 });
    await p.suspect(3);
    await p.suspect(2);
    expect(await scan.scan()).toEqual({ created: 0, grown: 0 });
    await p.suspect(1);
    expect(await scan.scan()).toEqual({ created: 1, grown: 0 });
    const open = await p.mine("?status=open");
    expect(open).toHaveLength(1);
    expect(open[0]!.tradeCount).toBe(3);
  });

  it("com a API fora na hora, ela acha ao voltar: o alerta olha os 7 dias, não só o último minuto", async () => {
    const p = await pair();
    await p.suspect(150);
    await p.suspect(100);
    await p.suspect(60);
    expect((await scan.scan()).created).toBe(1);
  });

  it("negócio já anulado não conta", async () => {
    const p = await pair();
    const first = await p.suspect(30);
    await p.suspect(20);
    await p.suspect(10);
    await database.db.insert(tradeAnnulments).values({ tradeId: first, caseId: 999, at: clock.now() });
    expect(await scan.scan()).toEqual({ created: 0, grown: 0 });
    expect(await p.mine()).toEqual([]);
  });

  it("admin 31: só o admin lê a lista de casos", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/fraud/cases" });
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/fraud/cases/1" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "POST", url: "/admin/fraud/cases", payload: {} }, { okStatus: 400 });
  });
});
