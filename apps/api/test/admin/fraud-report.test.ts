import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { count } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fraudCaseDetailSchema, type FraudCaseDetail } from "@futbolsa/contracts";
import { formatBRL } from "@futbolsa/engine";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, fraudCases } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { insertTrade } from "../market/helpers.js";
import { openTreasury } from "../market/order-helpers.js";
import { applyMovements, ipoBuy, portfolioSeason, type PortfolioSeason } from "../portfolio/support.js";

// F14, T22: o relatório do caso (Admin 41). Julho de 2027 fechado, "hoje" em 10 de agosto.

const at = (iso: string) => new Date(iso);
const D = ["2027-07-05T15:00:00Z", "2027-07-06T15:00:00Z", "2027-07-07T15:00:00Z"].map(at);

describe("relatório de trapaça", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(at("2027-08-10T15:00:00Z"));
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let admin: TestAccount;
  let token: string;
  let ana: { account: TestAccount; wallet: number };
  let bruno: { account: TestAccount; wallet: number };
  let carla: { account: TestAccount; wallet: number };
  let spt: number;
  let tradeIds: number[];

  const player = async (nickname: string) => {
    const account = await createAccount(database.db, { nickname });
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    return { account, wallet: wallet! };
  };
  const open = (body: object) => app.inject({ method: "POST", url: "/admin/fraud/cases", headers: bearer(token), payload: body });
  const get = async (id: number, query = ""): Promise<FraudCaseDetail> => {
    const res = await app.inject({ method: "GET", url: `/admin/fraud/cases/${id}${query}`, headers: bearer(token) });
    expect(res.statusCode, res.body).toBe(200);
    return fraudCaseDetailSchema.parse(res.json());
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await portfolioSeason(database.db);
    spt = s.clubIds.get("SPT3")!;
    admin = await createAccount(database.db, { role: "admin" });
    token = await admin.tokenWith({ at: clock.now() });
    ana = await player("Ana");
    bruno = await player("Bruno");
    carla = await player("Carla");
    await applyMovements(database.db, ana.wallet, at("2027-04-05T14:00:00Z"), ipoBuy(spt, 10, 4000));
    await applyMovements(database.db, bruno.wallet, at("2027-04-05T14:00:00Z"), ipoBuy(spt, 10, 4000));
    // Ana compra 1 SPT3 de Bruno três vezes, 10% acima do preço anterior em cada uma: R$ 44,00, R$ 48,40 e R$ 53,24
    const prices = [4400, 4840, 5324];
    tradeIds = [];
    for (let i = 0; i < 3; i++) {
      const id = await insertTrade(database.db, { seasonId: s.seasonId, clubId: spt, at: D[i]!, price: prices[i]!, priceBefore: i === 0 ? 4000 : prices[i - 1]!, quantity: 1, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet });
      tradeIds.push(id);
      const ref = { type: "trade", id };
      await applyMovements(database.db, ana.wallet, D[i]!, { kind: "trade", clubId: spt, sharesDelta: 1, cashDelta: -prices[i]!, price: prices[i]!, costBasis: "purchase", ref });
      await applyMovements(database.db, bruno.wallet, D[i]!, { kind: "trade", clubId: spt, sharesDelta: -1, cashDelta: prices[i]!, price: prices[i]!, costBasis: "sale", ref });
    }
    // Ana também vende 1 SPT3 a Carla em julho: um negócio com outro jogador
    const other = await insertTrade(database.db, { seasonId: s.seasonId, clubId: spt, at: at("2027-07-08T15:00:00Z"), price: 5400, priceBefore: 5324, quantity: 1, buyerWalletId: carla.wallet, sellerWalletId: ana.wallet });
    const ref = { type: "trade", id: other };
    await applyMovements(database.db, ana.wallet, at("2027-07-08T15:00:00Z"), { kind: "trade", clubId: spt, sharesDelta: -1, cashDelta: 5400, price: 5400, costBasis: "sale", ref });
    await applyMovements(database.db, carla.wallet, at("2027-07-08T15:00:00Z"), { kind: "trade", clubId: spt, sharesDelta: 1, cashDelta: -5400, price: 5400, costBasis: "purchase", ref });
  });
  afterAll(() => app?.close());

  it("admin 41: os 3 negócios com hora, quantidade, preço, preço anterior e variação, e toda a alta vem deles", async () => {
    const res = await open({ accountA: { userId: ana.account.id }, accountB: { userId: bruno.account.id }, from: "2027-07-01T00:00:00Z", to: "2027-07-31T23:59:59Z", ticker: "SPT3" });
    expect(res.statusCode, res.body).toBe(201);
    const detail = fraudCaseDetailSchema.parse(res.json());
    expect(detail).toMatchObject({ origin: "manual", status: "open", ticker: "SPT3", reportHash: null });
    expect(detail.parties.map((p) => p.label).sort()).toEqual(["Ana", "Bruno"]);
    expect(detail.parties.find((p) => p.label === "Ana")!.email).toBe(ana.account.email);

    const { report } = detail;
    expect(report.trades.map((t) => [t.id, t.quantity, t.price, t.priceBefore, t.variationBp, t.suspicious, t.selected])).toEqual([
      [tradeIds[0], 1, 4400, 4000, 1000, true, false],
      [tradeIds[1], 1, 4840, 4400, 1000, true, false],
      [tradeIds[2], 1, 5324, 4840, 1000, true, false],
    ]);
    expect(report.trades[0]!.at).toBe(D[0]!.toISOString());
    // peso no clube: 3 de 4 negócios do SPT3 no período são do par; o negócio com Carla (R$ 54,00) é de outro jogador e vale
    expect(report.clubs).toEqual([{ ticker: "SPT3", clubTrades: 4, pairTrades: 3, priceFrom: 4000, priceTo: 5400, priceToWithoutPair: 5400 }]);
    // preço com e sem: o último ponto está depois do negócio com Carla
    const last = report.series.filter((p) => p.ticker === "SPT3").at(-1)!;
    expect(last).toMatchObject({ price: 5400, priceWithout: 5400 });
    const afterThird = report.series.find((p) => p.at.startsWith("2027-07-08T02:59"))!;
    expect(afterThird).toMatchObject({ price: 5324, priceWithout: 4000 });
    expect(report.series.length).toBeLessThanOrEqual(60);
  });

  it("admin 41: patrimônio de julho com e sem os negócios, e os negócios com outros aparecem à parte", async () => {
    const [created] = await database.db.select().from(fraudCases);
    const { report } = await get(created!.id);
    const july = report.months.find((m) => m.month === "2027-07")!;
    expect(july.open).toBe(false);
    const a = july.accounts.find((x) => x.walletId === ana.wallet)!;
    // com: R$ 14.564,00 a menos de caixa, 3 SPT3 a mais e 1 vendida a R$ 54,00; sem: tudo isso some e o preço volta a R$ 40,00
    expect(a.equity).toBeGreaterThan(a.equityWithout);
    expect(a.rank === null || a.rankWithout === null || a.rank <= a.rankWithout).toBe(true);
    expect(report.others).toHaveLength(1);
    expect(report.others[0]).toMatchObject({ walletId: ana.wallet, side: "sell", price: 5400 });
  });

  it("admin 41: o efeito antes de confirmar, com os negócios marcados na tela", async () => {
    const [created] = await database.db.select().from(fraudCases);
    const none = await get(created!.id, `?without=${tradeIds[2]}`);
    const july = none.report.months.find((m) => m.month === "2027-07")!;
    const all = (await get(created!.id)).report.months.find((m) => m.month === "2027-07")!;
    // tirando só o 3º negócio a diferença é menor que tirando os três
    const diff = (m: typeof july) => m.accounts.find((x) => x.walletId === ana.wallet)!.equity - m.accounts.find((x) => x.walletId === ana.wallet)!.equityWithout;
    expect(Math.abs(diff(july))).toBeLessThan(Math.abs(diff(all)));
  });

  it("admin 41: relatório manual de um par sem suspeitos abre e nada fica marcado", async () => {
    const res = await open({ accountA: { userId: ana.account.id }, accountB: { userId: carla.account.id }, from: "2027-07-01T00:00:00Z", to: "2027-07-31T23:59:59Z" });
    expect(res.statusCode, res.body).toBe(201);
    const detail = fraudCaseDetailSchema.parse(res.json());
    expect(detail.report.trades).toHaveLength(1);
    expect(detail.report.trades.every((t) => !t.suspicious && !t.selected)).toBe(true);
  });

  it("admin 41: a mesma conta nos dois lados é recusada, e conta sem carteira também", async () => {
    const same = await open({ accountA: { userId: ana.account.id }, accountB: { userId: ana.account.id }, from: "2027-07-01T00:00:00Z", to: "2027-07-31T00:00:00Z" });
    expect(same.statusCode).toBe(400);
    expect(same.json().code).toBe("fraud_same_account");
    const lone = await createAccount(database.db);
    const none = await open({ accountA: { userId: ana.account.id }, accountB: { userId: lone.id }, from: "2027-07-01T00:00:00Z", to: "2027-07-31T00:00:00Z" });
    expect(none.statusCode).toBe(404);
    expect(none.json().code).toBe("no_wallet");
  });

  it("admin 41: abrir o relatório (GET) não escreve nada", async () => {
    const [created] = await database.db.select().from(fraudCases);
    const before = [(await database.db.select({ n: count() }).from(fraudCases))[0]!.n, (await database.db.select({ n: count() }).from(adminLog))[0]!.n];
    await get(created!.id);
    await get(created!.id, `?without=${tradeIds[0]}`);
    const after = [(await database.db.select({ n: count() }).from(fraudCases))[0]!.n, (await database.db.select({ n: count() }).from(adminLog))[0]!.n];
    expect(after).toEqual(before);
  });

  it("admin 41: o arquivo baixado tem os mesmos números da foto e abre sozinho", async () => {
    const [created] = await database.db.select().from(fraudCases);
    const detail = await get(created!.id);
    const res = await app.inject({ method: "GET", url: `/admin/fraud/cases/${created!.id}/download`, headers: bearer(token) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-disposition"]).toContain("attachment");
    const html = res.body;
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<style>");
    expect(html).toContain("<svg");
    expect(html).not.toMatch(/<script|src=|href=/);
    // os números da foto: preço de cada negócio e o preço do fim do período
    for (const t of detail.report.trades) expect(html).toContain(formatBRL(t.price));
    expect(html).toContain(formatBRL(detail.report.clubs[0]!.priceTo));
    expect(html).toContain("Ana");
    expect(html).toContain(ana.account.nickname);
    expect(html).not.toContain(ana.account.email);
  });

  it("admin 41: depois da exclusão de uma conta o arquivo não tem o e-mail nem o apelido dela", async () => {
    const res0 = await open({ accountA: { userId: bruno.account.id }, accountB: { userId: carla.account.id }, from: "2027-07-01T00:00:00Z", to: "2027-07-31T23:59:59Z" });
    const id = fraudCaseDetailSchema.parse(res0.json()).id;
    await openTreasury(database.db, s.seasonId);
    await app.get(AccountDeletionService).deleteAccount(carla.account.id);
    const res = await app.inject({ method: "GET", url: `/admin/fraud/cases/${id}/download`, headers: bearer(token) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain("conta excluída");
    expect(res.body).not.toContain("Carla");
    expect(res.body).not.toContain(carla.account.email);
  });

  it("caso inexistente dá case_not_found", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/fraud/cases/999999", headers: bearer(token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("case_not_found");
  });

});
