import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { banFraudResponseSchema, confirmFraudResponseSchema, playerDetailSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, fraudCases, fraudWarnings, orders, playerNotices, seasons, users } from "../../src/infra/db/schema/index.js";
import { NoticeMailJob } from "../../src/infra/jobs/notice-mail.js";
import { OrderService } from "../../src/modules/market/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, seedSeason } from "../support/fixtures.js";
import { marketSeason, type MarketSeason } from "../market/helpers.js";
import { accepted, giveShares, openBot, orderInputs, syncTotalShares } from "../market/order-helpers.js";
import { ALL_TICKERS, botIdOf, brt, newPlayer, openCase, pairTrade, type Player } from "./fraud-decision-helpers.js";

// F14, T27: advertência e banimento por trapaça (Admin, critério 45). O relógio é o dos tokens de `createAccount`
// (TOKEN_T0 + 60 s, 1º de abril de 2027), para o `expectAdminOnly` valer; os negócios do par são de março.

const REASON = "negócios combinados para subir o preço";
const BAN = "reincidência: segundo caso confirmado";
const FROM = "2027-03-01T00:00:00Z";
const TO = "2027-04-01T12:00:00Z";

describe("advertência e banimento por trapaça", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let admin: TestAccount;
  let keys = 0;

  const db = () => database.db;
  const club = (ticker: string) => s.clubIds.get(ticker)!;
  const player = (nickname?: string) => newPlayer(database.db, s.seasonId, nickname ? { nickname } : {});
  const shares = async (wallet: number, ticker: string, quantity: number) => {
    await giveShares(database.db, wallet, club(ticker), quantity, 4000);
    await syncTotalShares(database.db, s.seasonId);
  };
  const deal = (ticker: string, buyer: number, seller: number, day: string) =>
    pairTrade(database.db, s.seasonId, club(ticker), ticker, { buyer, seller, at: brt(day), price: 4400, priceBefore: 4000 });
  const caseOf = (a: { userId: string } | { botId: number }, b: { userId: string } | { botId: number }, ticker: string) =>
    openCase(app, admin.token, a, b, { ticker, from: FROM, to: TO });
  const confirm = async (caseId: number, tradeIds: number[]) => {
    const res = await app.inject({
      method: "POST",
      url: `/admin/fraud/cases/${caseId}/confirm`,
      headers: { ...bearer(admin.token), "idempotency-key": `ban-${++keys}` },
      payload: { tradeIds, reason: REASON },
    });
    expect(res.statusCode, res.body).toBe(200);
    return confirmFraudResponseSchema.parse(res.json());
  };
  /** Um caso confirmado do par, com um negócio no clube dado. */
  const confirmedCase = async (a: Player, b: Player, ticker: string, day: string) => {
    await shares(b.wallet, ticker, 5);
    const id = await deal(ticker, a.wallet, b.wallet, day);
    const caseId = await caseOf({ userId: a.account.id }, { userId: b.account.id }, ticker);
    return { caseId, body: await confirm(caseId, [id]) };
  };
  const ban = (caseId: number, userId: string, reason: string | null = BAN) =>
    app.inject({ method: "POST", url: `/admin/fraud/cases/${caseId}/ban`, headers: bearer(admin.token), payload: { userId, ...(reason === null ? {} : { reason }) } });
  const refused = (res: Awaited<ReturnType<typeof ban>>, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    expect(res.json().code).toBe(code);
  };
  const detail = async (userId: string) => {
    const res = await app.inject({ method: "GET", url: `/admin/players/${userId}`, headers: bearer(admin.token) });
    expect(res.statusCode, res.body).toBe(200);
    return playerDetailSchema.parse(res.json());
  };
  const userRow = async (id: string) => (await database.db.select().from(users).where(eq(users.id, id)))[0]!;
  const noticesOf = async (userId: string) => database.db.select().from(playerNotices).where(eq(playerNotices.userId, userId)).orderBy(asc(playerNotices.id));
  const banLogs = async (userId: string) => database.db.select().from(adminLog).where(and(eq(adminLog.action, "fraud.ban"), eq(adminLog.targetId, userId)));

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db, { tickers: ALL_TICKERS, tradingOpensAt: new Date("2027-03-01T13:00:00Z") });
    admin = await createAccount(database.db, { role: "admin" });
  });
  afterAll(() => app?.close());

  let ana: Player;
  let bruno: Player;
  let carla: Player;
  let first: number;
  let second: number;

  it("admin 45: Ana com 1 advertência num novo caso com Carla recebe a oferta de banir; banida com motivo, fica bloqueada, recebe o aviso e o registro guarda o relatório, o motivo e as duas advertências", async () => {
    ana = await player("Ana");
    bruno = await player("Bruno");
    carla = await player("Carla");
    const one = await confirmedCase(ana, bruno, "SPT3", "2027-03-10");
    first = one.caseId;
    expect(one.body.banOffer).toEqual([]);
    const two = await confirmedCase(ana, carla, "PAL3", "2027-03-20");
    second = two.caseId;
    expect(two.body.banOffer).toEqual([{ userId: ana.account.id, label: "Ana", previousWarnings: 1 }]);

    // uma compra aberta de Ana: o bloqueio a cancela
    const input = orderInputs({ seasonId: s.seasonId, now: clock.now() });
    const open = accepted(await app.get(OrderService).place(input.buyLimit(ana.wallet, "COR3", 1, 4000)));
    const wake = vi.spyOn(app.get(NoticeMailJob), "wake");

    const res = await ban(second, ana.account.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(banFraudResponseSchema.parse(res.json())).toEqual({ userId: ana.account.id, status: "blocked" });

    // bloqueada pelo bloqueio da T3, com o motivo começando por "trapaça"; a ordem cancelada
    const row = await userRow(ana.account.id);
    expect(row.status).toBe("blocked");
    expect(row.blockedReason).toMatch(/^trapaça/);
    expect(row.blockedReason).toContain(BAN);
    expect((await database.db.select().from(orders).where(eq(orders.id, open.order.id)))[0]).toMatchObject({ status: "cancelled", cancelReason: "blocked" });

    // o aviso fraud_ban, sem a outra conta, e o e-mail acordado
    const notice = (await noticesOf(ana.account.id)).at(-1)!;
    expect(notice).toMatchObject({ kind: "fraud_ban", readAt: null, emailSentAt: null, body: { reason: BAN, trades: [] } });
    expect(JSON.stringify(notice.body)).not.toContain("Carla");
    expect(wake).toHaveBeenCalled();
    wake.mockRestore();

    // o registro: o caso, o hash da foto, o motivo e as duas advertências (ids e datas), sem e-mail nem apelido
    const caseRow = (await database.db.select().from(fraudCases).where(eq(fraudCases.id, second)))[0]!;
    const warnings = await database.db.select().from(fraudWarnings).where(eq(fraudWarnings.userId, ana.account.id)).orderBy(asc(fraudWarnings.id));
    expect(warnings.map((w) => w.caseId)).toEqual([first, second]);
    const [log] = await banLogs(ana.account.id);
    expect(log).toMatchObject({ actorId: admin.id, targetType: "player", reason: BAN });
    const after = log!.after as { caseId: number; reportHash: string; warnings: Array<{ id: number; caseId: number; at: string }>; status: string };
    expect(after).toMatchObject({ caseId: second, reportHash: caseRow.reportHash, status: "blocked" });
    expect(after.warnings).toEqual(warnings.map((w) => ({ id: Number(w.id), caseId: Number(w.caseId), at: w.at.toISOString() })));
    expect(JSON.stringify(log)).not.toMatch(/@/);
    expect(JSON.stringify(log)).not.toContain("Ana");
    expect(JSON.stringify(log)).not.toContain("Carla");

    // já banida
    refused(await ban(second, ana.account.id), 409, "already_blocked");
    expect(await banLogs(ana.account.id)).toHaveLength(1);

    // o detalhe mostra as duas advertências da temporada, com o caso e a data
    expect((await detail(ana.account.id)).warnings).toEqual(warnings.map((w) => ({ caseId: Number(w.caseId), at: w.at.toISOString() })));
  });

  it("primeira advertência não oferece e o ban recusa: Bruno e Carla, Ana no primeiro caso, caso aberto, descartado, inexistente, conta de fora e sem motivo", async () => {
    refused(await ban(first, bruno.account.id), 409, "ban_not_offered");
    refused(await ban(second, carla.account.id), 409, "ban_not_offered");
    // o primeiro caso de Ana foi a primeira advertência
    await database.db.update(users).set({ status: "active", blockedReason: null }).where(eq(users.id, ana.account.id));
    refused(await ban(first, ana.account.id), 409, "ban_not_offered");
    await database.db.update(users).set({ status: "blocked", blockedReason: `trapaça: ${BAN}` }).where(eq(users.id, ana.account.id));

    // Bruno reincide num caso ainda aberto: sem decisão, sem banimento
    const dan = await player();
    await shares(dan.wallet, "COR3", 5);
    await deal("COR3", bruno.wallet, dan.wallet, "2027-03-21");
    const open = await caseOf({ userId: bruno.account.id }, { userId: dan.account.id }, "COR3");
    refused(await ban(open, bruno.account.id), 409, "ban_not_offered");
    const dismissed = await app.inject({ method: "POST", url: `/admin/fraud/cases/${open}/dismiss`, headers: bearer(admin.token), payload: { reason: "foi coincidência" } });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    refused(await ban(open, bruno.account.id), 409, "ban_not_offered");

    refused(await ban(999_999, bruno.account.id), 404, "case_not_found");
    refused(await ban(second, dan.account.id), 409, "ban_not_offered");
    expect((await ban(second, ana.account.id, "")).statusCode).toBe(400);
    expect((await ban(second, ana.account.id, null)).statusCode).toBe(400);

    for (const p of [bruno, carla, dan]) expect((await userRow(p.account.id)).status).toBe("active");
    expect(await noticesOf(bruno.account.id)).toHaveLength(1); // só o aviso da advertência
  });

  it("o desbloqueio devolve a conta e a advertência fica", async () => {
    const res = await app.inject({ method: "POST", url: `/admin/players/${ana.account.id}/unblock`, headers: bearer(admin.token), payload: { reason: "cumpriu a pena" } });
    expect(res.statusCode, res.body).toBe(200);
    const d = await detail(ana.account.id);
    expect(d.account).toMatchObject({ status: "active", blockedReason: null });
    expect(d.warnings.map((w) => w.caseId)).toEqual([first, second]);
  });

  it("bot não tem advertência: no caso com bot, só a conta de jogador é advertida", async () => {
    const eva = await player();
    const bot = await openBot(db(), s.seasonId, INITIAL_CASH);
    await shares(bot, "CRU3", 5);
    const id = await deal("CRU3", eva.wallet, bot, "2027-03-22");
    const caseId = await caseOf({ userId: eva.account.id }, { botId: await botIdOf(db(), bot) }, "CRU3");
    expect((await confirm(caseId, [id])).banOffer).toEqual([]);
    const rows = await database.db.select().from(fraudWarnings).where(eq(fraudWarnings.caseId, caseId));
    expect(rows.map((r) => r.userId)).toEqual([eva.account.id]);
    expect((await detail(eva.account.id)).warnings).toEqual([{ caseId, at: clock.now().toISOString() }]);
    // conta sem advertência nenhuma: lista vazia
    expect((await detail((await player()).account.id)).warnings).toEqual([]);
  });

  it("temporada nova começa sem advertências: o detalhe só lê as da temporada atual", async () => {
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, s.seasonId));
    await seedSeason(database.db, 2028);
    expect((await detail(ana.account.id)).warnings).toEqual([]);
    // as advertências continuam no banco, da temporada delas
    expect(await database.db.select().from(fraudWarnings).where(eq(fraudWarnings.userId, ana.account.id))).toHaveLength(2);
  });

  it("admin 31: a rota de banir é só de admin", async () => {
    await expectAdminOnly(app, database.db, { method: "POST", url: "/admin/fraud/cases/999999/ban", payload: { userId: admin.id, reason: "teste de acesso" } }, { okStatus: 404 });
  });
});
