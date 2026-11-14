import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clubChannel, confirmFraudResponseSchema, fraudReportSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import {
  adminLog,
  fraudCases,
  fraudCaseTrades,
  fraudWarnings,
  orders,
  payoutHoldings,
  playerNotices,
  positions,
  rankingRecalcRequests,
  seasons,
  tradeAnnulments,
  walletEntries,
} from "../../src/infra/db/schema/index.js";
import { EventBus, meChannel, type BusEvent } from "../../src/infra/realtime/index.js";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { reportHash } from "../../src/modules/admin/fraud/report.js";
import { displayedPrice, OrderService } from "../../src/modules/market/index.js";
import { EquityAt } from "../../src/modules/portfolio/valuation/equity-at.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH } from "../support/fixtures.js";
import { assertCandlesMatchTrades, assertLedgerConsistent, assertReservesMatchOrders, assertSharesConserved, totalCash } from "../support/invariants.js";
import { marketSeason, type MarketSeason } from "../market/helpers.js";
import { accepted, giveShares, openBot, openTreasury, orderInputs, positionOf, setTunnelState, syncTotalShares, walletOf } from "../market/order-helpers.js";
import { applyMovements, insertPayout } from "../portfolio/support.js";
import { ALL_TICKERS, botIdOf, brt, newPlayer, openCase, pairTrade, type Player } from "./fraud-decision-helpers.js";

// F14, T25: decidir o caso de trapaça (Admin, critérios 42 e 44). "Hoje" é 5 de agosto de 2027; os negócios do par são
// de julho, gravados como o motor de ordens os deixa (histórico), e cada cenário usa o próprio clube.

const NOW = new Date("2027-08-05T15:00:00Z");
const REASON = "negócios combinados para subir o preço";

describe("decidir o caso de trapaça", () => {
  const database = useTestDatabase(20);
  const clock = new FixedClock(NOW);
  let app: NestFastifyApplication;
  let bus: EventBus;
  let s: MarketSeason;
  let admin: TestAccount;
  let token: string;
  let treasury: number;
  let keys = 0;

  const db = () => database.db;
  const club = (ticker: string) => s.clubIds.get(ticker)!;
  const player = (nickname?: string) => newPlayer(database.db, s.seasonId, nickname ? { nickname } : {});
  const shares = async (wallet: number, ticker: string, quantity: number, price = 4000) => {
    await giveShares(database.db, wallet, club(ticker), quantity, price);
    await syncTotalShares(database.db, s.seasonId);
  };
  const deal = (ticker: string, t: Parameters<typeof pairTrade>[4]) => pairTrade(database.db, s.seasonId, club(ticker), ticker, t);
  const caseOf = (a: Player, b: Player, ticker?: string) => openCase(app, token, { userId: a.account.id }, { userId: b.account.id }, ticker ? { ticker } : {});
  const confirm = (caseId: number, tradeIds: number[], o: { reason?: string; key?: string | null; as?: string } = {}) =>
    app.inject({
      method: "POST",
      url: `/admin/fraud/cases/${caseId}/confirm`,
      headers: { ...bearer(o.as ?? token), ...(o.key === null ? {} : { "idempotency-key": o.key ?? `k-${++keys}` }) },
      payload: { tradeIds, reason: o.reason ?? REASON },
    });
  const dismiss = (caseId: number, reason = "foi coincidência", as = token) =>
    app.inject({ method: "POST", url: `/admin/fraud/cases/${caseId}/dismiss`, headers: bearer(as), payload: { reason } });
  const ok = (res: Awaited<ReturnType<typeof confirm>>) => {
    expect(res.statusCode, res.body).toBe(200);
    return confirmFraudResponseSchema.parse(res.json());
  };
  const refused = (res: Awaited<ReturnType<typeof confirm>>, status: number, code: string) => {
    expect(res.statusCode, res.body).toBe(status);
    expect(res.json().code).toBe(code);
  };
  const caseRow = async (id: number) => (await database.db.select().from(fraudCases).where(eq(fraudCases.id, id)))[0]!;
  const annulledOf = async (ids: number[]) => database.db.select().from(tradeAnnulments).where(inArray(tradeAnnulments.tradeId, ids));
  const warningsOf = async (userId: string) => database.db.select().from(fraudWarnings).where(eq(fraudWarnings.userId, userId));
  const noticesOf = async (userId: string) => database.db.select().from(playerNotices).where(eq(playerNotices.userId, userId)).orderBy(asc(playerNotices.id));
  const annulLines = async (wallet: number) =>
    database.db.select().from(walletEntries).where(and(eq(walletEntries.walletId, wallet), eq(walletEntries.kind, "trade_annulled"))).orderBy(asc(walletEntries.id));
  const entryCount = async (wallet: number) => (await database.db.select({ n: count() }).from(walletEntries).where(eq(walletEntries.walletId, wallet)))[0]!.n;
  const fullPosition = async (wallet: number, ticker: string) =>
    (await database.db.select().from(positions).where(and(eq(positions.walletId, wallet), eq(positions.clubId, club(ticker)))))[0];
  const watch = (stream: Parameters<EventBus["subscribe"]>[0]) => {
    const got: BusEvent[] = [];
    bus.subscribe(stream, (e) => got.push(e));
    return () => got.map((e) => JSON.parse(e.frame) as { type: string; data: Record<string, unknown> });
  };
  const invariants = async () => {
    await assertLedgerConsistent(database.db, s.seasonId);
    await assertSharesConserved(database.db, s.seasonId);
    await assertReservesMatchOrders(database.db, s.seasonId);
    await assertCandlesMatchTrades(database.db, s.seasonId);
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    bus = app.get(EventBus, { strict: false });
    s = await marketSeason(database.db, { tickers: ALL_TICKERS });
    treasury = await openTreasury(database.db, s.seasonId);
    admin = await createAccount(database.db, { role: "admin" });
    token = await admin.tokenWith({ at: clock.now() });
  });
  afterAll(() => app?.close());

  let ana: Player;

  it("admin 42: de ponta a ponta, Bruno recebe de volta as 3 SPT3, Ana os R$ 25,48, o preço volta a R$ 7,00 e cada um tem 1 advertência", async () => {
    await setTunnelState(db(), s.seasonId, club("SPT3"), { ipoPrice: 700, lastPrice: 700 });
    ana = await player("Ana");
    const bruno = await player("Bruno");
    const [carla, dan] = [await player(), await player()];
    await shares(bruno.wallet, "SPT3", 10, 700);
    await shares(carla.wallet, "SPT3", 5, 700);
    const before = await deal("SPT3", { buyer: dan.wallet, seller: carla.wallet, at: brt("2027-07-20"), price: 700 });
    const ids = [
      await deal("SPT3", { buyer: ana.wallet, seller: bruno.wallet, at: brt("2027-07-25"), price: 770, priceBefore: 700 }),
      await deal("SPT3", { buyer: ana.wallet, seller: bruno.wallet, at: brt("2027-07-28"), price: 847, priceBefore: 770 }),
      await deal("SPT3", { buyer: ana.wallet, seller: bruno.wallet, at: brt("2027-07-31"), price: 931, priceBefore: 847 }),
    ];
    // um dividendo pago a Ana no meio do caminho: não muda (proposta 19)
    await applyMovements(db(), ana.wallet, brt("2027-07-29"), { kind: "dividend", clubId: club("SPT3"), cashDelta: 50 });
    const caseId = await caseOf(ana, bruno, "SPT3");
    const club$ = watch(clubChannel("SPT3"));
    const anaMe = watch(meChannel(ana.account.id));
    const cashBefore = await totalCash(db(), s.seasonId);

    const key = "chave-admin-42";
    const body = ok(await confirm(caseId, ids, { key }));
    expect(body).toMatchObject({ caseId, status: "confirmed", banOffer: [] });
    expect([...body.annulled].sort((a, b) => a.tradeId - b.tradeId)).toEqual([
      { tradeId: ids[0], sharesReturned: 1, sharesShort: 0, cashReturned: 770 },
      { tradeId: ids[1], sharesReturned: 1, sharesShort: 0, cashReturned: 847 },
      { tradeId: ids[2], sharesReturned: 1, sharesShort: 0, cashReturned: 931 },
    ]);

    // o dinheiro e as ações: Ana recebe R$ 25,48, Bruno as 3 de volta, com o custo e o resultado de antes
    expect((await walletOf(db(), ana.wallet)).cash).toBe(INITIAL_CASH + 50);
    expect((await walletOf(db(), bruno.wallet)).cash).toBe(INITIAL_CASH);
    expect(await fullPosition(ana.wallet, "SPT3")).toMatchObject({ shares: 0, cost: 0, realized: 0, dividends: 50 });
    expect(await fullPosition(bruno.wallet, "SPT3")).toMatchObject({ shares: 10, cost: 7000, realized: 0 });
    expect(await totalCash(db(), s.seasonId)).toBe(cashBefore);
    // o extrato dos dois: uma linha por negócio, com o negócio no ref e o motivo
    const anaLines = await annulLines(ana.wallet);
    expect(anaLines.map((l) => [Number(l.refId), l.sharesDelta, l.cashDelta, l.reason])).toEqual([
      [ids[2], -1, 931, REASON],
      [ids[1], -1, 847, REASON],
      [ids[0], -1, 770, REASON],
    ]);
    expect((await annulLines(bruno.wallet)).map((l) => [l.sharesDelta, l.cashDelta])).toEqual([
      [1, -931],
      [1, -847],
      [1, -770],
    ]);
    // nenhum estorno de dividendo
    expect(await database.db.select().from(walletEntries).where(and(eq(walletEntries.walletId, ana.wallet), eq(walletEntries.kind, "reversal")))).toEqual([]);

    // o preço volta a R$ 7,00 (o negócio de Carla com Dan, de antes, continua)
    expect(await displayedPrice(db(), s.seasonId, "SPT3")).toBe(700);
    expect((await annulledOf(ids)).length).toBe(3);
    expect((await annulledOf([before])).length).toBe(0);

    // advertência e aviso, um para cada, sem a outra conta
    expect(await warningsOf(ana.account.id)).toHaveLength(1);
    expect(await warningsOf(bruno.account.id)).toHaveLength(1);
    const [anaNotice] = await noticesOf(ana.account.id);
    expect(anaNotice).toMatchObject({ kind: "fraud_warning", readAt: null, emailSentAt: null });
    expect(anaNotice!.body).toMatchObject({ reason: REASON, trades: [{ ticker: "SPT3", quantity: 1, price: 770, value: 770 }, { price: 847 }, { price: 931 }] });
    expect(JSON.stringify(anaNotice!.body)).not.toContain(bruno.account.nickname);
    expect(JSON.stringify((await noticesOf(bruno.account.id))[0]!.body)).not.toContain(ana.account.nickname);

    // o caso: decidido, com a foto e o hash dela; os negócios marcados
    const row = await caseRow(caseId);
    expect(row).toMatchObject({ status: "confirmed", decidedBy: admin.id, decisionReason: REASON });
    const report = fraudReportSchema.parse(row.report);
    expect(row.reportHash).toBe(reportHash(report));
    expect(JSON.stringify(report)).not.toContain(ana.account.email);
    expect(report.trades.filter((t) => t.selected).map((t) => t.id).sort()).toEqual([...ids].sort());
    const marks = await database.db.select().from(fraudCaseTrades).where(eq(fraudCaseTrades.caseId, caseId));
    expect(marks.every((m) => m.selected)).toBe(true);

    // o registro do admin: o id do caso e o hash, sem e-mail
    const [log] = await database.db.select().from(adminLog).where(and(eq(adminLog.action, "fraud.confirm"), eq(adminLog.targetId, String(caseId))));
    expect(log).toMatchObject({ actorId: admin.id, targetType: "fraud_case", reason: REASON });
    expect((log!.after as { reportHash: string }).reportHash).toBe(row.reportHash);
    expect(JSON.stringify(log)).not.toMatch(/@/);

    // o recálculo dos rankings, pedido na mesma transação desde o negócio mais antigo (e já atendido: a decisão o acorda)
    const recalcs = await database.db.select().from(rankingRecalcRequests).where(eq(rankingRecalcRequests.seasonId, s.seasonId));
    expect(recalcs).toEqual([expect.objectContaining({ fromAt: brt("2027-07-25"), reason: "trapaça: negócios anulados" })]);

    // depois do COMMIT: history_changed no clube, sem detalhes; wallet.changed e entry.added para Ana
    const changed = club$().filter((f) => f.type === "history_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.data).toEqual({});
    const mine = anaMe().map((f) => f.type);
    expect(mine.filter((t) => t === "wallet.changed")).toHaveLength(3);
    expect(mine.filter((t) => t === "entry.added")).toHaveLength(3);

    // a mesma chave não anula duas vezes; outra chave encontra o caso decidido
    const entries = await entryCount(ana.wallet);
    const again = ok(await confirm(caseId, ids, { key }));
    expect(again).toEqual(body);
    expect(await entryCount(ana.wallet)).toBe(entries);
    refused(await confirm(caseId, ids), 409, "case_already_decided");
    await invariants();
  });

  it("admin 42: só os marcados são anulados e os outros valem; bot não tem advertência e Ana, já advertida, recebe a oferta de banir", async () => {
    const bot = await openBot(db(), s.seasonId, INITIAL_CASH);
    await shares(bot, "PAL3", 10);
    const ids = [
      await deal("PAL3", { buyer: ana.wallet, seller: bot, at: brt("2027-07-21"), price: 4400, priceBefore: 4000 }),
      await deal("PAL3", { buyer: ana.wallet, seller: bot, at: brt("2027-07-22"), price: 4840, priceBefore: 4400 }),
      await deal("PAL3", { buyer: ana.wallet, seller: bot, at: brt("2027-07-23"), price: 5324, priceBefore: 4840 }),
    ];
    const caseId = await openCase(app, token, { userId: ana.account.id }, { botId: await botIdOf(db(), bot) }, { ticker: "PAL3" });

    const body = ok(await confirm(caseId, [ids[0]!, ids[1]!]));
    expect(body.annulled.map((a) => a.tradeId).sort()).toEqual([ids[0], ids[1]].sort());
    expect(body.banOffer).toEqual([{ userId: ana.account.id, label: "Ana", previousWarnings: 1 }]);
    expect((await annulledOf(ids)).map((a) => a.tradeId).sort()).toEqual([ids[0], ids[1]].sort());
    // o terceiro vale: o preço continua o dele, e Ana fica com 1 PAL3
    expect(await displayedPrice(db(), s.seasonId, "PAL3")).toBe(5324);
    expect((await positionOf(db(), ana.wallet, club("PAL3"))).shares).toBe(1);
    expect((await positionOf(db(), bot, club("PAL3"))).shares).toBe(9);
    // a advertência é só da conta de jogador
    expect(await database.db.select().from(fraudWarnings).where(eq(fraudWarnings.caseId, caseId))).toHaveLength(1);
    expect(await warningsOf(ana.account.id)).toHaveLength(2);
    const notices = await noticesOf(ana.account.id);
    expect((notices.at(-1)!.body as { trades: unknown[] }).trades).toHaveLength(2);
    await invariants();
  });

  it("recusas: sem motivo, sem chave, negócio fora do caso ou repetido, caso inexistente, clube em leilão, temporada encerrada, motivo com e-mail; nada muda", async () => {
    const [eva, fabio] = [await player(), await player()];
    await shares(fabio.wallet, "COR3", 10);
    const ids = [
      await deal("COR3", { buyer: eva.wallet, seller: fabio.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000 }),
      await deal("COR3", { buyer: eva.wallet, seller: fabio.wallet, at: brt("2027-07-22"), price: 4840, priceBefore: 4400 }),
    ];
    const first = await caseOf(eva, fabio, "COR3");
    const second = await caseOf(eva, fabio, "COR3");
    const entries = await entryCount(eva.wallet);

    expect((await confirm(first, ids, { reason: "" })).statusCode).toBe(400);
    expect((await confirm(first, ids, { reason: "  " })).statusCode).toBe(400);
    refused(await confirm(first, ids, { key: null }), 400, "idempotency_key_required");
    const outside = (await annulLines(ana.wallet))[0]!;
    refused(await confirm(first, [Number(outside.refId)]), 409, "trade_not_annullable");
    refused(await confirm(first, [ids[0]!, ids[0]!]), 409, "trade_not_annullable");
    refused(await confirm(999_999, ids), 404, "case_not_found");

    await setTunnelState(db(), s.seasonId, club("COR3"), { auctionOpenedAt: NOW, auctionUntil: new Date(NOW.getTime() + 3_600_000) });
    refused(await confirm(first, ids), 409, "club_in_auction");
    await setTunnelState(db(), s.seasonId, club("COR3"), { auctionOpenedAt: null, auctionUntil: null });

    // temporada encerrada: `season_closed` (F15, T7); fora da negociação: `annul_not_allowed`
    for (const [status, code] of [["closed", "season_closed"], ["ipo_open", "annul_not_allowed"]] as const) {
      await database.db.update(seasons).set({ status }).where(eq(seasons.id, s.seasonId));
      refused(await confirm(first, ids), 409, code);
    }
    await database.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, s.seasonId));
    refused(await confirm(first, ids, { reason: "ver eva@exemplo.com" }), 400, "reason_has_email");

    // nada mudou: o caso aberto, nenhum negócio anulado, o extrato igual
    expect((await caseRow(first)).status).toBe("open");
    expect(await annulledOf(ids)).toEqual([]);
    expect(await entryCount(eva.wallet)).toBe(entries);
    expect(await noticesOf(eva.account.id)).toEqual([]);

    // negócio já anulado por outro caso
    ok(await confirm(first, [ids[0]!]));
    refused(await confirm(second, [ids[0]!]), 409, "trade_not_annullable");
    expect((await caseRow(second)).status).toBe("open");
    await invariants();
  });

  it("admin parte do caso não decide (cannot_target_self), e jogador comum recebe 403", async () => {
    const other = await newPlayer(db(), s.seasonId, { role: "admin" });
    const gil = await player();
    await shares(gil.wallet, "CRU3", 5);
    const id = await deal("CRU3", { buyer: other.wallet, seller: gil.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000 });
    const caseId = await caseOf(other, gil, "CRU3");
    const as = await other.account.tokenWith({ at: clock.now() });
    refused(await confirm(caseId, [id], { as }), 409, "cannot_target_self");
    refused(await dismiss(caseId, "foi coincidência", as), 409, "cannot_target_self");
    const plain = await gil.account.tokenWith({ at: clock.now() });
    expect((await confirm(caseId, [id], { as: plain })).statusCode).toBe(403);
    expect((await dismiss(caseId, "foi coincidência", plain)).statusCode).toBe(403);
    expect((await caseRow(caseId)).status).toBe("open");
  });

  it("admin 44: descartar não anula nada, não avisa ninguém e guarda o relatório", async () => {
    const [hugo, iris] = [await player(), await player()];
    await shares(iris.wallet, "CAM3", 5);
    const ids = [
      await deal("CAM3", { buyer: hugo.wallet, seller: iris.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000 }),
      await deal("CAM3", { buyer: hugo.wallet, seller: iris.wallet, at: brt("2027-07-22"), price: 4840, priceBefore: 4400 }),
    ];
    const caseId = await caseOf(hugo, iris, "CAM3");
    const entries = [await entryCount(hugo.wallet), await entryCount(iris.wallet)];

    const res = await dismiss(caseId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ caseId, status: "dismissed" });
    const row = await caseRow(caseId);
    expect(row).toMatchObject({ status: "dismissed", decidedBy: admin.id, decisionReason: "foi coincidência" });
    expect(row.reportHash).toBe(reportHash(fraudReportSchema.parse(row.report)));
    expect(await annulledOf(ids)).toEqual([]);
    expect(await displayedPrice(db(), s.seasonId, "CAM3")).toBe(4840);
    expect([await entryCount(hugo.wallet), await entryCount(iris.wallet)]).toEqual(entries);
    expect([...(await noticesOf(hugo.account.id)), ...(await noticesOf(iris.account.id))]).toEqual([]);
    expect([...(await warningsOf(hugo.account.id)), ...(await warningsOf(iris.account.id))]).toEqual([]);
    const [log] = await database.db.select().from(adminLog).where(and(eq(adminLog.action, "fraud.dismiss"), eq(adminLog.targetId, String(caseId))));
    expect((log!.after as { reportHash: string }).reportHash).toBe(row.reportHash);

    refused(await dismiss(caseId), 409, "case_already_decided");
    refused(await confirm(caseId, ids), 409, "case_already_decided");
    // o relatório do caso decidido é a foto guardada
    const detail = await app.inject({ method: "GET", url: `/admin/fraud/cases/${caseId}`, headers: bearer(token) });
    expect(detail.json()).toMatchObject({ status: "dismissed", reportHash: row.reportHash });
  });

  it("conta excluída que vendeu: as ações voltam para a tesouraria e a conta viva recebe o que pagou; só ela é avisada", async () => {
    const [joao, katia] = [await player(), await player()];
    await shares(joao.wallet, "FLU3", 10);
    const id = await deal("FLU3", { buyer: katia.wallet, seller: joao.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000, quantity: 2 });
    const caseId = await caseOf(joao, katia, "FLU3");
    await app.get(AccountDeletionService).deleteAccount(joao.account.id);
    const vault = (await positionOf(db(), treasury, club("FLU3"))).shares;
    const cashBefore = await totalCash(db(), s.seasonId);
    const deletedEntries = await entryCount(joao.wallet);

    const body = ok(await confirm(caseId, [id]));
    expect(body.annulled).toEqual([{ tradeId: id, sharesReturned: 2, sharesShort: 0, cashReturned: 8800 }]);
    expect((await positionOf(db(), katia.wallet, club("FLU3"))).shares).toBe(0);
    expect((await walletOf(db(), katia.wallet)).cash).toBe(INITIAL_CASH);
    expect((await positionOf(db(), treasury, club("FLU3"))).shares).toBe(vault + 2);
    // o dinheiro que Kátia recebe é criado: o caixa da conta excluída sumiu na exclusão
    expect(await totalCash(db(), s.seasonId)).toBe(cashBefore + 8800);
    expect(await entryCount(joao.wallet)).toBe(deletedEntries);
    expect(await database.db.select().from(fraudWarnings).where(eq(fraudWarnings.caseId, caseId))).toHaveLength(1);
    expect(await noticesOf(katia.account.id)).toHaveLength(1);
    expect(await noticesOf(joao.account.id)).toEqual([]);
    await invariants();
  });

  it("conta excluída que comprou: a conta viva recebe as ações das livres da tesouraria e devolve o dinheiro", async () => {
    const [lia, max] = [await player(), await player()];
    await shares(lia.wallet, "BOT3", 10);
    const id = await deal("BOT3", { buyer: max.wallet, seller: lia.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000, quantity: 2 });
    const caseId = await caseOf(lia, max, "BOT3");
    await app.get(AccountDeletionService).deleteAccount(max.account.id);
    expect((await positionOf(db(), treasury, club("BOT3"))).shares).toBe(2);
    const cashBefore = await totalCash(db(), s.seasonId);

    const body = ok(await confirm(caseId, [id]));
    expect(body.annulled).toEqual([{ tradeId: id, sharesReturned: 2, sharesShort: 0, cashReturned: 8800 }]);
    expect((await positionOf(db(), lia.wallet, club("BOT3"))).shares).toBe(10);
    expect(await fullPosition(lia.wallet, "BOT3")).toMatchObject({ cost: 40_000, realized: 0 });
    expect((await walletOf(db(), lia.wallet)).cash).toBe(INITIAL_CASH);
    expect((await positionOf(db(), treasury, club("BOT3"))).shares).toBe(0);
    // o dinheiro que Lia devolve some
    expect(await totalCash(db(), s.seasonId)).toBe(cashBefore - 8800);
    await invariants();
  });

  it("tesouraria sem ações livres segue a regra da falta: nada se move e a linha fica no extrato", async () => {
    const [nina, otto, carla] = [await player(), await player(), await player()];
    await shares(nina.wallet, "VAS3", 10);
    const id = await deal("VAS3", { buyer: otto.wallet, seller: nina.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000, quantity: 2 });
    await deal("VAS3", { buyer: carla.wallet, seller: otto.wallet, at: brt("2027-07-22"), price: 4400, quantity: 2 });
    const caseId = await caseOf(nina, otto, "VAS3");
    await app.get(AccountDeletionService).deleteAccount(otto.account.id);
    expect((await positionOf(db(), treasury, club("VAS3"))).shares).toBe(0);
    const ninaCash = (await walletOf(db(), nina.wallet)).cash;

    const body = ok(await confirm(caseId, [id]));
    expect(body.annulled).toEqual([{ tradeId: id, sharesReturned: 0, sharesShort: 2, cashReturned: 0 }]);
    expect((await walletOf(db(), nina.wallet)).cash).toBe(ninaCash);
    expect((await positionOf(db(), nina.wallet, club("VAS3"))).shares).toBe(8);
    expect((await annulLines(nina.wallet)).map((l) => [l.sharesDelta, l.cashDelta, Number(l.refId)])).toEqual([[0, 0, id]]);
    await invariants();
  });

  it("vendas de Ana canceladas só quando faltam ações livres", async () => {
    const orderSvc = app.get(OrderService);
    const input = orderInputs({ seasonId: s.seasonId, now: clock.now() });
    const run = async (ticker: string, selling: number) => {
      const [pia, quim] = [await player(), await player()];
      await shares(pia.wallet, ticker, 5);
      await shares(quim.wallet, ticker, 10);
      const ids = [
        await deal(ticker, { buyer: pia.wallet, seller: quim.wallet, at: brt("2027-07-21"), price: 4200, priceBefore: 4000 }),
        await deal(ticker, { buyer: pia.wallet, seller: quim.wallet, at: brt("2027-07-22"), price: 4410, priceBefore: 4200 }),
        await deal(ticker, { buyer: pia.wallet, seller: quim.wallet, at: brt("2027-07-23"), price: 4631, priceBefore: 4410 }),
      ];
      const sale = accepted(await orderSvc.place(input.sellLimit(pia.wallet, ticker, selling, 5000)));
      const caseId = await caseOf(pia, quim, ticker);
      const body = ok(await confirm(caseId, ids));
      return { body, order: (await database.db.select().from(orders).where(eq(orders.id, sale.order.id)))[0]!, pia };
    };
    // 8 SAO3, 4 presas na venda: as 4 livres cobrem as 3 a devolver, e a venda fica
    const kept = await run("SAO3", 4);
    expect(kept.order).toMatchObject({ status: "open", cancelReason: null });
    expect(kept.body.annulled.every((a) => a.sharesReturned === 1)).toBe(true);
    // 7 presas: só 1 livre, então a venda é cancelada com o motivo annulment e as 3 voltam
    const cut = await run("SAN3", 7);
    expect(cut.order).toMatchObject({ status: "cancelled", cancelReason: "annulment" });
    expect(cut.body.annulled.every((a) => a.sharesReturned === 1)).toBe(true);
    expect(await positionOf(db(), cut.pia.wallet, club("SAN3"))).toMatchObject({ shares: 5, reservedShares: 0 });
    await invariants();
  });

  it("compras de quem vendeu canceladas só quando o caixa livre não cobre, e o caixa fica negativo", async () => {
    const orderSvc = app.get(OrderService);
    const input = orderInputs({ seasonId: s.seasonId, now: clock.now() });
    // Rui tem caixa de sobra: a compra aberta fica
    const [rui, sara] = [await player(), await player()];
    await shares(rui.wallet, "GRE3", 5);
    const ruiTrade = await deal("GRE3", { buyer: sara.wallet, seller: rui.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000, quantity: 3 });
    const ruiBuy = accepted(await orderSvc.place(input.buyLimit(rui.wallet, "GRE3", 1, 4000)));
    ok(await confirm(await caseOf(rui, sara, "GRE3"), [ruiTrade]));
    expect((await database.db.select().from(orders).where(eq(orders.id, ruiBuy.order.id)))[0]).toMatchObject({ status: "open" });

    // Tito gastou o dinheiro: com R$ 50,00 e uma compra de R$ 40,00 aberta noutro clube, devolve R$ 132,00
    const [tito, uma] = [await player(), await player()];
    await shares(tito.wallet, "INT3", 5);
    const titoTrade = await deal("INT3", { buyer: uma.wallet, seller: tito.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000, quantity: 3 });
    const titoCash = (await walletOf(db(), tito.wallet)).cash;
    await applyMovements(db(), tito.wallet, brt("2027-07-25"), { kind: "adjustment", cashDelta: -(titoCash - 5000), reason: "gastou o caixa" });
    const titoBuy = accepted(await orderSvc.place(input.buyLimit(tito.wallet, "CEA3", 1, 4000)));
    ok(await confirm(await caseOf(tito, uma, "INT3"), [titoTrade]));
    expect((await database.db.select().from(orders).where(eq(orders.id, titoBuy.order.id)))[0]).toMatchObject({ status: "cancelled", cancelReason: "annulment" });
    expect(await walletOf(db(), tito.wallet)).toMatchObject({ cash: 5000 - 13_200, reservedCash: 0, openOrders: 0 });
    await invariants();
  });

  it("admin 42 em trading_ended: desfeito em dinheiro pela recompra (pendente e aprovada); ações e foto não mudam; o patrimônio no fechamento é o de sem os negócios", async () => {
    const [vera, wil] = [await player(), await player()];
    await shares(wil.wallet, "JUV3", 10);
    await shares(wil.wallet, "VIT3", 10);
    const juv = await deal("JUV3", { buyer: vera.wallet, seller: wil.wallet, at: brt("2027-07-21"), price: 4400, priceBefore: 4000, quantity: 3 });
    const vit = await deal("VIT3", { buyer: vera.wallet, seller: wil.wallet, at: brt("2027-07-22"), price: 4400, priceBefore: 4000, quantity: 2 });
    const caseId = await caseOf(vera, wil);
    await database.db.update(seasons).set({ status: "trading_ended", tradingEndedAt: brt("2027-08-01", "00:00") }).where(eq(seasons.id, s.seasonId));
    const closedAt = brt("2027-08-02", "00:00");
    const events = [
      await insertPayout(db(), { seasonId: s.seasonId, clubId: club("JUV3") }, { key: `buyback|temporada|fim|JUV3`, kind: "buyback", perShare: 500, closedAt, status: "pending", holdings: [[vera.wallet, 3], [wil.wallet, 7]] }),
      await insertPayout(db(), { seasonId: s.seasonId, clubId: club("VIT3") }, { key: `buyback|temporada|fim|VIT3`, kind: "buyback", perShare: 300, closedAt, status: "approved", holdings: [[vera.wallet, 2], [wil.wallet, 8]] }),
    ];
    const photo = await database.db.select().from(payoutHoldings).where(inArray(payoutHoldings.eventId, events));
    const [veraCash, wilCash] = [(await walletOf(db(), vera.wallet)).cash, (await walletOf(db(), wil.wallet)).cash];

    const body = ok(await confirm(caseId, [juv, vit]));
    expect([...body.annulled].sort((a, b) => a.tradeId - b.tradeId)).toEqual([
      { tradeId: juv, sharesReturned: 3, sharesShort: 0, cashReturned: 3 * (4400 - 500) },
      { tradeId: vit, sharesReturned: 2, sharesShort: 0, cashReturned: 2 * (4400 - 300) },
    ]);
    // Vera recebe R$ 132,00 + R$ 88,00 e devolve R$ 15,00 + R$ 6,00; Wil o contrário
    expect((await walletOf(db(), vera.wallet)).cash).toBe(veraCash + 11_700 + 8_200);
    expect((await walletOf(db(), wil.wallet)).cash).toBe(wilCash - 11_700 - 8_200);
    expect((await positionOf(db(), vera.wallet, club("JUV3"))).shares).toBe(3);
    expect((await positionOf(db(), wil.wallet, club("VIT3"))).shares).toBe(8);
    expect(await database.db.select().from(payoutHoldings).where(inArray(payoutHoldings.eventId, events))).toEqual(photo);
    // no fechamento da recompra, o patrimônio de cada um é o de quem nunca fez os negócios
    const equity = await withTransaction(db(), (tx) => EquityAt.forSeason(tx, s.seasonId, new Date(closedAt.getTime() + 60_000), { wallets: [vera.wallet, wil.wallet] }));
    expect(equity.get(vera.wallet)!.equity).toBe(INITIAL_CASH);
    expect(equity.get(wil.wallet)!.equity).toBe(INITIAL_CASH + 10 * 500 + 10 * 300);
    await invariants();
    await database.db.update(seasons).set({ status: "trading", tradingEndedAt: null }).where(eq(seasons.id, s.seasonId));
  });
});
