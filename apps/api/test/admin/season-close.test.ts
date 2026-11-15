import { CLUBS } from "@futbolsa/engine";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockSeason, lockWallets, withTransaction } from "../../src/infra/db/index.js";
import {
  adminLog,
  fraudCases,
  portfolioSnapshots,
  positions,
  rankingRows,
  rankingSnapshots,
  seasonResults,
  seasons,
  users,
  walletEntries,
  wallets,
} from "../../src/infra/db/schema/index.js";
import { AccountsService } from "../../src/modules/accounts/index.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { CloseService, RecalcService } from "../../src/modules/rankings/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { after, CALLS, prepareCalls, RecordingRankings, type Season, SilentWaker } from "../payouts/correction-scene.js";
import { at, buybackScene, REGISTERED } from "./buyback-scene.js";

/** O IPO da temporada abre em 28/03 (os meses de março a novembro fecham pelo histórico). */
const IPO_OPENS = at("2027-03-28T19:00:00Z");
/** O encerramento: 20/12/2027 às 12h de Brasília, depois da recompra aprovada. */
const C = at("2027-12-20T15:00:00Z");
const BASE = 10_000_000;

describe("encerramento da temporada (F15, T6)", () => {
  const t = useTestDatabase(30);
  const clock = new FixedClock(REGISTERED);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  const scene = buybackScene(() => t.db, () => app, clock, 2027);

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
    });
    await scene.init();
  });
  afterAll(async () => {
    await app?.get(SettleCreditsService, { strict: false }).whenIdle();
    await app?.close();
  });
  beforeEach(async () => {
    rankings.reset();
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  /** A temporada com a recompra fechada às 18h15 da final; com `approve`, tudo aprovado e liquidado. */
  async function ended(setup: (s: Season) => Promise<void>, options: { approve?: boolean } = {}): Promise<Season> {
    const s = await scene.newSeason();
    await t.db.update(seasons).set({ ipoOpensAt: IPO_OPENS }).where(eq(seasons.id, s.seasonId));
    await setup(s);
    await scene.seasonEnd(s);
    const summary = await scene.close(s.seasonId, REGISTERED);
    expect(summary.errors).toEqual([]);
    if (options.approve ?? true) {
      await scene.approveAll(after(REGISTERED, 30));
      expect(await pendingOf(s)).toBe(0);
    }
    return s;
  }

  const pendingOf = async (s: Season) => {
    const { rows } = await t.db.execute(sql`select count(*)::int as n from futbolsa.payout_events where season_id = ${s.seasonId} and status = 'pending'`);
    return Number(rows[0]!.n);
  };

  async function call(method: "GET" | "POST", url: string, payload?: object, now: Date = C) {
    clock.set(now);
    const token = await scene.admin.tokenWith({ at: now });
    return app.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${token}` } });
  }
  const yearOf = async (s: Season) => (await scene.seasonOf(s)).year;
  const closeRoute = async (s: Season, now: Date = C, year?: number) =>
    call("POST", `/admin/seasons/${s.seasonId}/close`, { confirmYear: year ?? (await yearOf(s)) }, now);
  const previewRoute = (s: Season, now: Date = C) => call("GET", `/admin/seasons/${s.seasonId}/close`, undefined, now);

  const walletsOf = (s: Season) => t.db.select().from(wallets).where(eq(wallets.seasonId, s.seasonId)).orderBy(asc(wallets.id));
  const userOf = async (walletId: number) => (await t.db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!.userId!;
  const resultOf = async (s: Season, walletId: number) =>
    (await t.db.select().from(seasonResults).where(and(eq(seasonResults.seasonId, s.seasonId), eq(seasonResults.userId, await userOf(walletId)))))[0];
  const snapshotsOf = (s: Season, period: "month" | "season") =>
    t.db.select().from(rankingSnapshots).where(and(eq(rankingSnapshots.seasonId, s.seasonId), eq(rankingSnapshots.period, period))).orderBy(asc(rankingSnapshots.periodKey));
  async function annualRows(s: Season) {
    const [snap] = await snapshotsOf(s, "season");
    if (!snap) return null;
    return new Map((await t.db.select().from(rankingRows).where(eq(rankingRows.snapshotId, snap.id))).map((r) => [r.walletId, r]));
  }
  const sharesIn = async (s: Season) => {
    const { rows } = await t.db.execute(sql`
      select coalesce(sum(p.shares), 0)::int as n from futbolsa.positions p join futbolsa.wallets w on w.id = p.wallet_id where w.season_id = ${s.seasonId}`);
    return Number(rows[0]!.n);
  };
  const entryCount = async () => Number((await t.db.execute(sql`select count(*)::int as n from futbolsa.wallet_entries`)).rows[0]!.n);

  it("admin 21: o POST com pagamento pendente é recusado com a lista; a prévia mostra a mesma lista com o texto e a tela", async () => {
    let ana = 0;
    const s = await ended(
      async (season) => {
        ana = await scene.player(season);
        await scene.buy(season, ana, "FLA3", 1_000);
      },
      { approve: false },
    );
    const before = await entryCount();
    const res = await closeRoute(s);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("season_close_blocked");
    const codes = body.blockers.map((b: { code: string }) => b.code);
    expect(codes).toEqual(["payouts_pending", "buyback_not_approved", "shares_remaining"]);
    expect(body.blockers[0]).toMatchObject({ link: "/admin/pagamentos", text: expect.stringContaining("aguardando aprovação") });
    expect(body.blockers[1]).toMatchObject({ code: "buyback_not_approved", count: CLUBS.length - 2, link: "/admin/pagamentos" });
    expect(body.blockers[2]).toMatchObject({ link: null });
    // nada mudou
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading_ended", closedAt: null });
    expect(await entryCount()).toBe(before);
    expect(await snapshotsOf(s, "season")).toEqual([]);

    const preview = await previewRoute(s);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ seasonId: s.seasonId, status: "trading_ended", canClose: false, blockers: body.blockers });
  });

  it("admin 21: jogo sem placar e caso de trapaça aberto aparecem na lista, com a tela de cada um", async () => {
    const s = await scene.newSeason();
    await scene.seasonEnd(s, { cdb: { home: "FLA3", away: "out3", score: null } });
    const a = await scene.player(s);
    const b = await scene.player(s);
    await t.db.insert(fraudCases).values({
      seasonId: s.seasonId,
      origin: "alert",
      walletLow: a,
      walletHigh: b,
      clubId: scene.club("FLA3"),
      periodFrom: REGISTERED,
      periodTo: REGISTERED,
      openedAt: REGISTERED,
    });
    const preview = (await previewRoute(s, REGISTERED)).json();
    expect(preview.blockers.map((x: { code: string }) => x.code)).toEqual(["buyback_not_closed", "matches_unscored", "shares_remaining", "fraud_open"]);
    const byCode = new Map(preview.blockers.map((x: { code: string }) => [x.code, x]));
    expect(byCode.get("buyback_not_closed")).toMatchObject({ count: 1, link: null });
    expect(byCode.get("matches_unscored")).toMatchObject({ count: 1, link: "/admin/jogos", text: "1 jogo sem placar." });
    expect(byCode.get("fraud_open")).toMatchObject({ count: 1, link: "/admin/trapaca", text: "1 caso de trapaça aberto." });
    expect(preview.canClose).toBe(false);
    const res = await closeRoute(s, REGISTERED);
    expect(res.json()).toMatchObject({ code: "season_close_blocked", blockers: preview.blockers });
  });

  it("admin 22 e 38: com tudo aprovado, o ano errado é recusado; com o certo, jogadores, bots e tesouraria ficam com R$ 0,00 e nenhuma ação, e o anual congela", async () => {
    const w = { ana: 0, bot: 0 };
    const s = await ended(async (season) => {
      w.ana = await scene.player(season);
      w.bot = await scene.bot(season);
      await scene.buy(season, w.ana, "FLA3", 1_000);
      await scene.buy(season, w.bot, "PAL3", 500);
    });
    const preview = (await previewRoute(s)).json();
    expect(preview).toMatchObject({ blockers: [], canClose: true, status: "trading_ended" });
    const total = (await walletsOf(s)).reduce((sum, x) => sum + x.cash, 0);
    expect(preview.summary).toMatchObject({ wallets: 3, totalCash: total });
    expect(preview.summary.leader).toMatchObject({ equity: BASE - 100_000 + 1_000 * (3_940 + 5_910) });

    // admin 38: o ano errado
    const wrong = await closeRoute(s, C, (await yearOf(s)) - 1);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("confirm_year_mismatch");
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading_ended" });

    const before = new Map((await walletsOf(s)).map((x) => [x.id, x.cash]));
    const res = await closeRoute(s);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ seasonId: s.seasonId, closedAt: C.toISOString(), wallets: 3, results: 1 });
    expect(await scene.seasonOf(s)).toMatchObject({ status: "closed", closedAt: C });
    for (const x of await walletsOf(s)) expect(x).toMatchObject({ cash: 0, reservedCash: 0 });
    expect(await sharesIn(s)).toBe(0);
    // uma linha `season_close` por carteira com caixa, que leva o caixa a zero
    for (const [id, cash] of before) {
      const lines = await scene.entriesOf(id, ["season_close"]);
      if (cash === 0) expect(lines).toEqual([]);
      else expect(lines).toEqual([expect.objectContaining({ cashDelta: -cash, cashAfter: 0, at: C })]);
    }
    // o anual congelou em C, com a recompra no patrimônio (não zero)
    const [annual] = await snapshotsOf(s, "season");
    expect(annual).toMatchObject({ closedAt: C, version: 1, periodKey: String(await yearOf(s)) });
    expect((await annualRows(s))!.get(w.ana)).toMatchObject({ equity: before.get(w.ana), base: BASE, position: 1 });
    // o registro do admin
    const [logged] = await t.db.select().from(adminLog).where(and(eq(adminLog.action, "season.close"), eq(adminLog.targetId, String(s.seasonId))));
    expect(logged).toMatchObject({ actorId: scene.admin.id, before: { status: "trading_ended", wallets: 3, totalCash: total } });
    expect(logged!.after).toMatchObject({ status: "closed", closedAt: C.toISOString(), walletsZeroed: 3, results: 1, annualClosed: true });
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);

    // encerrar de novo: `season_closed`, sem mudar nada
    const entries = await entryCount();
    const again = await closeRoute(s, after(C, 5));
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("season_closed");
    expect(await entryCount()).toBe(entries);
    expect(await scene.seasonOf(s)).toMatchObject({ closedAt: C });
  });

  it("conta 15, 16 e rankings 5: Ana termina com R$ 163.400,00, +63,4% e 2º; Bruno, que entrou em 2027-06-20, tem +40,00%; todos com R$ 0,00 e nenhuma ação", async () => {
    const w = { ana: 0, bruno: 0, caio: 0, bia: 0 };
    const s = await ended(async (season) => {
      w.caio = await scene.player(season);
      w.ana = await scene.player(season);
      w.bruno = await scene.player(season);
      w.bia = await scene.player(season, BASE, "blocked");
      await t.db.update(wallets).set({ enteredAt: at("2027-06-20T15:00:00Z"), entryMode: "cash" }).where(eq(wallets.id, w.bruno));
      // Ana: 1.000 FLA3 a R$ 35,10; com o título (R$ 39,40) e a recompra (R$ 59,10), R$ 163.400,00
      await scene.buyAt(season, w.ana, "FLA3", 1_000, 3_510, at("2027-05-01T15:00:00Z"));
      // Bruno: 4.000 PAL3 a R$ 3,88; com o título (R$ 5,55) e a recompra (R$ 8,33), R$ 140.000,00
      await scene.buyAt(season, w.bruno, "PAL3", 4_000, 388, at("2027-06-21T15:00:00Z"));
      // Caio, o 1º: 3.000 FLA3 a R$ 1,00
      await scene.buy(season, w.caio, "FLA3", 3_000);
    });
    expect(await scene.cashOf(w.ana)).toBe(16_340_000);
    expect((await closeRoute(s)).statusCode).toBe(200);

    const annual = (await annualRows(s))!;
    expect([...annual.keys()].sort((a, b) => a - b)).toEqual([w.caio, w.ana, w.bruno]);
    expect(annual.get(w.caio)!.position).toBe(1);
    expect(annual.get(w.ana)).toMatchObject({ equity: 16_340_000, base: BASE, position: 2 });
    expect(annual.get(w.bruno)).toMatchObject({ equity: 14_000_000, base: BASE, position: 3 });
    // conta 15: o histórico gravado (o retorno, +63,4%, sai de final/base na tela)
    expect(await resultOf(s, w.ana)).toMatchObject({ finalEquity: 16_340_000, base: BASE, position: 2 });
    expect((16_340_000 - BASE) / BASE).toBeCloseTo(0.634, 10);
    expect(await resultOf(s, w.bruno)).toMatchObject({ finalEquity: 14_000_000, base: BASE, position: 3 });
    // o bloqueado tem histórico sem posição, com o patrimônio medido em C
    expect(await resultOf(s, w.bia)).toMatchObject({ finalEquity: BASE, base: BASE, position: null });
    // conta 16: R$ 0,00 e nenhuma ação
    for (const id of Object.values(w)) {
      expect(await scene.cashOf(id)).toBe(0);
      const held = await t.db.select().from(positions).where(and(eq(positions.walletId, id), ne(positions.shares, 0)));
      expect(held).toEqual([]);
    }
    // a foto mensal de dezembro, em C, com o caixa de antes de zerar
    const [photo] = await t.db.select().from(portfolioSnapshots).where(and(eq(portfolioSnapshots.walletId, w.ana), eq(portfolioSnapshots.month, "2027-12")));
    expect(photo).toMatchObject({ takenAt: C, slices: { cash: 1000 } });
  });

  it("rankings 19 e 20: o anual fica parcial até o encerramento; encerrada em 2027-12-20, dezembro e o anual ficam oficiais no mesmo instante, e dezembro não ganha um segundo ranking", async () => {
    let ana = 0;
    const s = await ended(async (season) => {
      ana = await scene.player(season);
      await scene.buy(season, ana, "FLA3", 1_000);
    });
    // a tarefa do fim do mês, com a Série A e a final já disputadas: fecha os meses, não o ano
    const close = app.get(CloseService, { strict: false });
    clock.set(C);
    await close.runOnce(C);
    expect(await snapshotsOf(s, "season")).toEqual([]);
    expect((await snapshotsOf(s, "month")).map((x) => x.periodKey)).toContain("2027-11");
    expect((await snapshotsOf(s, "month")).map((x) => x.periodKey)).not.toContain("2027-12");

    // a tarefa pede o recálculo de cada mês que fecha: enquanto o pedido está aberto, o encerramento espera, e a
    // mensagem diz ao admin para esperar um minuto (a tarefa do recálculo atende em até um minuto)
    const blocked = await closeRoute(s);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().blockers).toEqual([
      expect.objectContaining({ code: "recalc_pending", count: 1, link: null, text: expect.stringContaining("Espere um minuto") }),
    ]);
    await app.get(RecalcService, { strict: false }).processRecalcRequests(C);

    expect((await closeRoute(s)).statusCode).toBe(200);
    const months = await snapshotsOf(s, "month");
    const december = months.filter((x) => x.periodKey === "2027-12");
    const [annual] = await snapshotsOf(s, "season");
    expect(december).toEqual([expect.objectContaining({ closedAt: C, version: 1 })]);
    expect(annual).toMatchObject({ closedAt: C, version: 1 });
    // com a recompra (e o título) no patrimônio
    const cash = BASE - 100_000 + 1_000 * (3_940 + 5_910);
    expect((await annualRows(s))!.get(ana)).toMatchObject({ equity: cash });
    // março a novembro, fechados pelo histórico, e dezembro: um ranking por mês
    expect(months.map((x) => x.periodKey)).toEqual(["2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12"]);

    // a tarefa do fim de dezembro (e o fechamento dos meses devidos) não grava outro dezembro
    await close.runOnce(at("2028-01-01T03:30:00Z"));
    await withTransaction(t.db, (tx) => close.closeMonthsDue(tx, s.seasonId, at("2028-01-01T03:30:00Z")));
    expect((await snapshotsOf(s, "month")).filter((x) => x.periodKey === "2027-12")).toHaveLength(1);
  });

  it("o caixa negativo vai a zero com a linha season_close e o patrimônio final gravado é o negativo; os bots no anual seguem a chave no encerramento", async () => {
    const w = { dora: 0, bot: 0 };
    const s = await ended(async (season) => {
      w.dora = await scene.player(season);
      w.bot = await scene.bot(season);
      await scene.buy(season, w.dora, "COR3", 100);
    });
    // um estorno deixa Dora com −R$ 1.234,00
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [w.dora]);
      const [now] = await tx.db.select().from(wallets).where(eq(wallets.id, w.dora));
      await post(tx, { walletId: w.dora, at: after(REGISTERED, 40), kind: "reversal", clubId: scene.club("COR3"), cashDelta: -(now!.cash + 123_400), ref: { type: "test", id: 1 }, reason: "estorno de teste" });
    });
    await t.db.update(seasons).set({ botsInRankings: true }).where(eq(seasons.id, s.seasonId));
    expect((await closeRoute(s)).statusCode).toBe(200);

    expect(await scene.entriesOf(w.dora, ["season_close"])).toEqual([expect.objectContaining({ cashDelta: 123_400, cashAfter: 0 })]);
    expect(await scene.cashOf(w.dora)).toBe(0);
    const annual = (await annualRows(s))!;
    expect(annual.get(w.dora)).toMatchObject({ equity: -123_400, base: BASE });
    expect(annual.get(w.bot)).toMatchObject({ equity: BASE });
    expect((await snapshotsOf(s, "season"))[0]).toMatchObject({ botsIncluded: true });
    expect(await resultOf(s, w.dora)).toMatchObject({ finalEquity: -123_400, base: BASE, position: 2 });
    await assertLedgerConsistent(t.db, s.seasonId);
  });

  it("conta 24 e conta 17: nenhuma conta recebe dinheiro no encerramento; depois, POST /admin/seasons cria a seguinte e a abertura do IPO dá R$ 100.000,00 a Bruno, com o histórico", async () => {
    let bruno = 0;
    const s = await ended(async (season) => {
      bruno = await scene.player(season);
      await scene.buy(season, bruno, "FLA3", 1_000);
    });
    const brunoUser = await userOf(bruno);
    const [{ nickname }] = (await t.db.select({ nickname: users.nickname }).from(users).where(eq(users.id, brunoUser))) as [{ nickname: string }];
    const walletsBefore = Number((await t.db.execute(sql`select count(*)::int as n from futbolsa.wallets`)).rows[0]!.n);
    const lastEntry = Number((await t.db.execute(sql`select coalesce(max(id), 0)::bigint as n from futbolsa.wallet_entries`)).rows[0]!.n);

    expect((await closeRoute(s)).statusCode).toBe(200);
    // conta 24: só linhas season_close, nenhuma carteira nova, nenhum caixa positivo em temporada nenhuma do Bruno
    const added = await t.db.select().from(walletEntries).where(sql`${walletEntries.id} > ${lastEntry}`);
    expect(added.length).toBeGreaterThan(0);
    for (const e of added) expect(e.kind).toBe("season_close");
    expect(added.filter((e) => e.cashDelta > 0)).toEqual([]);
    expect(Number((await t.db.execute(sql`select count(*)::int as n from futbolsa.wallets`)).rows[0]!.n)).toBe(walletsBefore);

    // a temporada seguinte: as outras temporadas dos testes deste arquivo são encerradas à força (só há uma fora de closed)
    await t.db.update(seasons).set({ status: "closed", closedAt: C }).where(ne(seasons.status, "closed"));
    const year = (await yearOf(s)) + 50;
    const created = await call("POST", "/admin/seasons", { year }, after(C, 60));
    expect(created.statusCode).toBe(201);
    const next = created.json() as { id: number; status: string };
    expect(next).toMatchObject({ year, status: "preparing" });

    // conta 17: a abertura do IPO (F8) credita R$ 100.000,00; Bruno sem ações, com o mesmo apelido e o histórico
    const opens = at("2028-03-27T19:00:00Z");
    await withTransaction(t.db, async (tx) => {
      await lockSeason(tx, next.id, "update");
      await tx.db.update(seasons).set({ status: "ipo_open", ipoOpensAt: opens }).where(eq(seasons.id, next.id));
      await app.get(AccountsService, { strict: false }).creditSeasonStart(tx, next.id, opens);
    });
    const [wallet] = await t.db.select().from(wallets).where(and(eq(wallets.seasonId, next.id), eq(wallets.userId, brunoUser)));
    expect(wallet).toMatchObject({ cash: BASE, reservedCash: 0 });
    expect(await t.db.select().from(positions).where(eq(positions.walletId, wallet!.id))).toEqual([]);
    const [user] = await t.db.select().from(users).where(eq(users.id, brunoUser));
    expect(user!.nickname).toBe(nickname);
    expect(await resultOf(s, bruno)).toMatchObject({ base: BASE, position: 1 });
  });
});
