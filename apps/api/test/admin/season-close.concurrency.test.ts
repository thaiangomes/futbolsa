import { performance } from "node:perf_hooks";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, payoutEvents, positions, rankingSnapshots, seasonResults, seasons, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { SeasonResultsService } from "../../src/modules/accounts/index.js";
import { ApproveService } from "../../src/modules/admin/payouts/approve.service.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SETTLE_BATCH, SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { PortfolioLedger, SnapshotService } from "../../src/modules/portfolio/index.js";
import { CloseService, RecalcService } from "../../src/modules/rankings/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { sleep, T0 } from "../support/fixtures.js";
import {
  assertCandlesMatchTrades,
  assertLedgerConsistent,
  assertOpenOrdersCounter,
  assertReservesMatchOrders,
  assertSharesConserved,
  totalCash,
} from "../support/invariants.js";
import { after, CALLS, prepareCalls, RecordingRankings, RICH, type Season, SilentWaker } from "../payouts/correction-scene.js";
import { A_END, at, BUYBACKS, buybackScene, REGISTERED } from "./buyback-scene.js";

/**
 * Concorrência e escala do fim da temporada (Plano do encerramento e da recompra, T10): o fechamento da recompra com
 * ordens chegando em vários clubes, duas aprovações da mesma recompra, dois encerramentos ao mesmo tempo (com a passada
 * de fechamento e a liquidação rodando junto) e o encerramento com 10 mil carteiras, com o tempo da transação medido.
 * No fim de cada caso, as invariantes: o estado de cada carteira é a soma do extrato, as ações do clube batem com o total
 * emitido e, na temporada encerrada, dinheiro e ações somam zero.
 */

const IPO_OPENS = at("2027-03-28T19:00:00Z");
/** O encerramento: 20/12/2027 às 12h de Brasília. */
const C = at("2027-12-20T15:00:00Z");
/** Os clubes em que as ordens chegam durante o fechamento da recompra. */
const RACE_CLUBS = ["FLA3", "PAL3", "SAO3", "GRE3", "COR3", "CAM3"];
const PRICE = 4_000;
/** Quantas carteiras o caso de escala abre. */
const SCALE_WALLETS = 10_000;
/** Linhas `adjustment` de caixa por carteira no caso de escala, para o extrato não ter só a linha inicial. */
const SCALE_ENTRIES = 10;

describe("fim da temporada com concorrência e escala (F15, T10)", () => {
  const t = useTestDatabase(30);
  const clock = new FixedClock(REGISTERED);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  let settle: SettleCreditsService;
  let approver: ApproveService;
  let second: TestAccount;
  const scene = buybackScene(() => t.db, () => app, clock, 2027);

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
    });
    settle = app.get(SettleCreditsService, { strict: false });
    approver = app.get(ApproveService, { strict: false });
    await scene.init();
    second = await createAccount(t.db, { role: "admin" });
  });
  afterAll(async () => {
    await settle?.whenIdle();
    await app?.close();
  });
  beforeEach(async () => {
    await settle.whenIdle();
    rankings.reset();
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  async function route(method: "GET" | "POST", url: string, payload: object | undefined, now: Date, account: TestAccount = scene.admin) {
    clock.set(now);
    const token = await account.tokenWith({ at: now });
    return app.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${token}` } });
  }
  const yearOf = async (s: Season) => (await scene.seasonOf(s)).year;
  const closeRoute = async (s: Season, account: TestAccount = scene.admin, now: Date = C) =>
    route("POST", `/admin/seasons/${s.seasonId}/close`, { confirmYear: await yearOf(s) }, now, account);

  /** A soma dos créditos de pagamento (dividendos e recompra) da temporada. */
  const creditedIn = async (s: Season) =>
    Number(
      (
        await t.db.execute(sql`
          select coalesce(sum(c.amount), 0)::bigint as n from futbolsa.payout_credits c
          join futbolsa.payout_events e on e.id = c.event_id where e.season_id = ${s.seasonId}`)
      ).rows[0]!.n,
    );
  const sharesIn = async (s: Season) =>
    Number(
      (
        await t.db.execute(sql`
          select coalesce(sum(p.shares), 0)::bigint as n from futbolsa.positions p
          join futbolsa.wallets w on w.id = p.wallet_id where w.season_id = ${s.seasonId}`)
      ).rows[0]!.n,
    );
  const count = async (query: ReturnType<typeof sql>) => Number((await t.db.execute(query)).rows[0]!.n);

  /** Dinheiro e ações da temporada encerrada somam zero, e cada carteira é a soma do extrato. */
  async function assertClosedSeasonEmpty(s: Season) {
    expect(await scene.seasonOf(s)).toMatchObject({ status: "closed" });
    const left = await t.db
      .select({ id: wallets.id, cash: wallets.cash, reserved: wallets.reservedCash, orders: wallets.openOrders })
      .from(wallets)
      .where(and(eq(wallets.seasonId, s.seasonId), sql`(${wallets.cash} <> 0 or ${wallets.reservedCash} <> 0 or ${wallets.openOrders} <> 0)`));
    expect(left).toEqual([]);
    expect(await totalCash(t.db, s.seasonId)).toBe(0);
    expect(await sharesIn(s)).toBe(0);
    const reserved = await t.db
      .select({ walletId: positions.walletId })
      .from(positions)
      .innerJoin(wallets, eq(wallets.id, positions.walletId))
      .where(and(eq(wallets.seasonId, s.seasonId), ne(positions.reservedShares, 0)));
    expect(reserved).toEqual([]);
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  }

  /** A temporada com o fim da final ainda sem placar (a recompra não fechou), com o IPO em 28/03. */
  async function endingSeason(): Promise<{ s: Season; final: Awaited<ReturnType<typeof scene.seasonEnd>> }> {
    const s = await scene.newSeason();
    await t.db.update(seasons).set({ ipoOpensAt: IPO_OPENS }).where(eq(seasons.id, s.seasonId));
    const final = await scene.seasonEnd(s, { cdb: { home: "FLA3", away: "out3", score: null } });
    // as outras competições já fecharam: os eventos delas ficam pendentes, e a negociação continua
    const pass = await scene.close(s.seasonId, after(A_END, 10));
    expect(pass.errors).toEqual([]);
    return { s, final };
  }

  /** A temporada com a recompra fechada às 18h15 da final e, com `approve`, tudo aprovado e liquidado. */
  async function ended(setup: (s: Season) => Promise<void>, options: { approve?: boolean } = {}): Promise<Season> {
    const s = await scene.newSeason();
    await t.db.update(seasons).set({ ipoOpensAt: IPO_OPENS }).where(eq(seasons.id, s.seasonId));
    await setup(s);
    await scene.seasonEnd(s);
    const summary = await scene.close(s.seasonId, REGISTERED);
    expect(summary.errors).toEqual([]);
    if (options.approve ?? true) {
      await scene.approveAll(after(REGISTERED, 30));
      await settle.whenIdle();
      expect(await count(sql`select count(*)::int as n from futbolsa.payout_events where season_id = ${s.seasonId} and status = 'pending'`)).toBe(0);
    }
    return s;
  }

  it("ordens em vários clubes enquanto a recompra fecha: nenhum negócio depois de D, as atrasadas recusadas com market_closed, e a foto e a recompra batem com as posições finais", async () => {
    const ROUNDS = 3;
    const ORDERS = 72;
    const totals = { ok: 0, closed: 0, trades: 0, afterRegistered: 0 };
    for (let round = 1; round <= ROUNDS; round++) {
      const { s, final } = await endingSeason();
      const sellers: number[] = [];
      const buyers: number[] = [];
      for (let i = 0; i < 6; i++) {
        const w = await scene.player(s);
        for (const ticker of RACE_CLUBS) await scene.buy(s, w, ticker, 400);
        sellers.push(w);
        buyers.push(await scene.player(s, RICH));
      }
      for (const ticker of RACE_CLUBS) await scene.setLastPrice(s, ticker, PRICE);
      await scene.registerFinal(final, [1, 0]);
      const cashBefore = await totalCash(t.db, s.seasonId);

      // duas filas por clube mandam ordens sem parar (vendas e compras que se cruzam no mesmo preço, com o horário
      // andando de 1 em 1 s a partir de 20 s antes do registro do fim da final) enquanto a passada fecha a recompra, e
      // mais algumas depois que ela acaba
      let passDone = false;
      const pass = scene.close(s.seasonId, REGISTERED).finally(() => {
        passDone = true;
      });
      const lane = async (ticker: string, k: number) => {
        const out: Array<{ ok: boolean; code?: string }> = [];
        let extra = 2;
        for (let i = 0; i < ORDERS && (!passDone || extra-- > 0); i++) {
          const sell = (i + k) % 2 === 0;
          const owner = (sell ? sellers : buyers)[(i + 3 * k) % 6]!;
          const now = new Date(REGISTERED.getTime() + (i - 20 + 25 * k) * 1_000);
          out.push(await scene.place(s, owner, ticker, sell ? "sell" : "buy", 10, PRICE, now));
        }
        return out;
      };
      const settled = await Promise.allSettled([pass, ...RACE_CLUBS.flatMap((ticker) => [lane(ticker, 0), lane(ticker, 1)])]);
      const failures = settled.filter((r) => r.status === "rejected");
      expect(failures, `rodada ${round}`).toEqual([]);
      const [summary, ...lanes] = settled.map((r) => (r as PromiseFulfilledResult<unknown>).value);
      expect((summary as { errors: string[] }).errors, `rodada ${round}`).toEqual([]);
      for (const v of (lanes as Array<Array<{ ok: boolean; code?: string }>>).flat()) {
        if (v.ok) totals.ok++;
        else {
          expect(v.code, `rodada ${round}`).toBe("market_closed");
          totals.closed++;
        }
      }

      // D: o fim gravado, nunca antes do último negócio; nenhum negócio com horário depois dele
      const season = await scene.seasonOf(s);
      expect(season.status).toBe("trading_ended");
      const D = season.tradingEndedAt!;
      expect(D.getTime()).toBeGreaterThanOrEqual(REGISTERED.getTime());
      if (D.getTime() > REGISTERED.getTime()) totals.afterRegistered++;
      expect(await count(sql`select count(*)::int as n from futbolsa.trades where season_id = ${s.seasonId} and at > ${D.toISOString()}::timestamptz`)).toBe(0);
      totals.trades += await count(sql`select count(*)::int as n from futbolsa.trades where season_id = ${s.seasonId}`);
      // os eventos de recompra têm o mesmo D
      const buybacks = await scene.buybacksOf(s);
      expect(buybacks.length).toBeGreaterThan(0);
      for (const e of buybacks) expect(e.closedAt.getTime()).toBe(D.getTime());

      // a ordem que chega depois, em qualquer clube, é recusada; nenhuma ordem ficou aberta
      for (const ticker of RACE_CLUBS) {
        expect(await scene.place(s, buyers[0]!, ticker, "buy", 1, PRICE, after(D, 1))).toMatchObject({ ok: false, code: "market_closed" });
      }
      expect(await count(sql`select count(*)::int as n from futbolsa.orders where season_id = ${s.seasonId} and status = 'open'`)).toBe(0);

      // a foto da recompra de cada clube é a posição final de cada carteira (sem a tesouraria)
      for (const e of buybacks) {
        const held = await t.db
          .select({ walletId: positions.walletId, shares: positions.shares })
          .from(positions)
          .innerJoin(wallets, eq(wallets.id, positions.walletId))
          .where(and(eq(wallets.seasonId, s.seasonId), eq(positions.clubId, e.clubId), gt(positions.shares, 0), ne(wallets.ownerType, "treasury")))
          .orderBy(asc(positions.walletId));
        expect(await scene.holdingsOf(e.id), `rodada ${round}, clube ${e.clubId}`).toEqual(held);
      }
      // o dinheiro só trocou de mãos; as reservas voltaram
      expect(await totalCash(t.db, s.seasonId)).toBe(cashBefore);
      await assertLedgerConsistent(t.db, s.seasonId);
      await assertSharesConserved(t.db, s.seasonId);
      await assertReservesMatchOrders(t.db, s.seasonId);
      await assertOpenOrdersCounter(t.db, s.seasonId);
      // os candles são do clube, não da temporada: nas rodadas seguintes (mesmos clubes, mesmo dia) eles somam as anteriores
      if (round === 1) await assertCandlesMatchTrades(t.db, s.seasonId);

      // a recompra paga pela foto e as ações somem; o caixa cresce exatamente o que foi creditado
      const expected = new Map<number, number>();
      for (const e of buybacks) for (const h of await scene.holdingsOf(e.id)) expected.set(h.walletId, (expected.get(h.walletId) ?? 0) + h.shares * e.perShare);
      await scene.approveAll(after(D, 30));
      await settle.whenIdle();
      expect(await sharesIn(s)).toBe(0);
      expect(await totalCash(t.db, s.seasonId)).toBe(cashBefore + (await creditedIn(s)));
      for (const e of await scene.buybacksOf(s)) {
        const paid = new Map((await scene.creditsOf(e.id)).map((c) => [c.walletId, c.amount]));
        for (const h of await scene.holdingsOf(e.id)) expect(paid.get(h.walletId)).toBe(h.shares * e.perShare);
      }
      await assertLedgerConsistent(t.db, s.seasonId);
      await assertSharesConserved(t.db, s.seasonId);

      // e o encerramento zera tudo
      const closed = await closeRoute(s);
      expect(closed.statusCode, closed.body).toBe(200);
      await assertClosedSeasonEmpty(s);
    }
    console.log(
      `[T10] fechamento da recompra com ordens: ${totals.ok} aceitas, ${totals.closed} recusadas com market_closed, ${totals.trades} negócios, D depois do registro em ${totals.afterRegistered} de ${ROUNDS} rodadas`,
    );
    // ao longo das rodadas, as duas coisas acontecem: ordem que entra antes do fechamento e ordem recusada depois
    expect(totals.ok).toBeGreaterThan(0);
    expect(totals.closed).toBeGreaterThan(0);
    expect(totals.trades).toBeGreaterThan(0);
  }, 180_000);

  it("duas aprovações da recompra do mesmo clube ao mesmo tempo pagam uma vez, com duas liquidações e a tarefa disputando as carteiras", async () => {
    const holders: number[] = [];
    const SHARES = [700, 300, 150];
    const s = await ended(
      async (season) => {
        for (const n of SHARES) {
          const w = await scene.player(season);
          for (const ticker of Object.keys(BUYBACKS)) await scene.buy(season, w, ticker, n);
          holders.push(w);
        }
        holders.push(await scene.bot(season));
        for (const ticker of Object.keys(BUYBACKS)) await scene.buy(season, holders[3]!, ticker, 50);
      },
      { approve: false },
    );
    // os dividendos primeiro, para a recompra ser a única disputa
    clock.set(after(REGISTERED, 20));
    const dividends = (await t.db.select().from(payoutEvents).where(and(eq(payoutEvents.seasonId, s.seasonId), eq(payoutEvents.status, "pending"), ne(payoutEvents.kind, "buyback")))).map((e) => e.id);
    await approver.approve(scene.admin.id, { eventIds: dividends });
    for (const id of dividends) await settle.settleEvent(id);
    await settle.whenIdle();
    const shares = [...SHARES, 50];

    // cada clube listado tem a recompra pendente; a disputa, clube a clube
    const events = (await scene.buybacksOf(s)).filter((e) => e.status === "pending");
    expect(events.length).toBeGreaterThan(Object.keys(BUYBACKS).length);
    const cashBefore = new Map(await Promise.all(holders.map(async (w) => [w, await scene.cashOf(w)] as const)));
    settle.batchSize = 1;
    try {
      for (const event of events) {
        clock.set(after(REGISTERED, 40));
        const responses = await Promise.all([
          approver.approve(scene.admin.id, { eventIds: [event.id] }),
          approver.approve(second.id, { eventIds: [event.id] }),
        ]);
        expect(responses.map((r) => r.results[0]!.outcome).sort(), `evento ${event.id}`).toEqual(["already_approved", "approved"]);
        await Promise.all([settle.settleEvent(event.id), settle.settleEvent(event.id), settle.settlePending()]);
        await settle.whenIdle();

        const holdings = await scene.holdingsOf(event.id);
        const credits = await scene.creditsOf(event.id);
        expect(credits.map((c) => [c.walletId, c.amount]), `evento ${event.id}`).toEqual(holdings.map((h) => [h.walletId, h.shares * event.perShare]));
        const lines = await t.db.select().from(walletEntries).where(and(eq(walletEntries.kind, "buyback"), eq(walletEntries.refId, String(event.id))));
        // uma linha por carteira da foto e uma só da tesouraria (as ações que sobraram, sem pagamento)
        expect(lines.filter((l) => l.walletId !== s.treasury)).toHaveLength(holdings.length);
        expect(lines.filter((l) => l.walletId === s.treasury)).toHaveLength(1);
        const logs = await t.db.select().from(adminLog).where(and(eq(adminLog.action, "payout.approve"), eq(adminLog.targetId, String(event.id))));
        expect(logs).toHaveLength(1);
        expect(await count(sql`select coalesce(sum(p.shares), 0)::int as n from futbolsa.positions p join futbolsa.wallets w on w.id = p.wallet_id where w.season_id = ${s.seasonId} and p.club_id = ${event.clubId}`)).toBe(0);
      }
    } finally {
      settle.batchSize = SETTLE_BATCH;
    }
    // cada carteira recebeu a recompra de cada clube uma vez
    for (const [i, w] of holders.entries()) {
      const paid = Object.values(BUYBACKS).reduce((sum, perShare) => sum + shares[i]! * perShare, 0);
      expect(await scene.cashOf(w)).toBe(cashBefore.get(w)! + paid);
    }
    expect(await sharesIn(s)).toBe(0);
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);

    const closed = await closeRoute(s);
    expect(closed.statusCode, closed.body).toBe(200);
    await assertClosedSeasonEmpty(s);
  }, 120_000);

  it("dois encerramentos ao mesmo tempo (com a passada de fechamento e a liquidação rodando junto): um passa, o outro recebe season_closed, e nada se duplica", async () => {
    for (let round = 1; round <= 3; round++) {
      const w: number[] = [];
      const s = await ended(async (season) => {
        for (let i = 0; i < 4; i++) w.push(await scene.player(season));
        w.push(await scene.player(season, RICH, "blocked"));
        w.push(await scene.bot(season));
        await scene.buy(season, w[0]!, "FLA3", 1_000);
        await scene.buy(season, w[1]!, "PAL3", 2_000);
        await scene.buy(season, w[5]!, "SAO3", 300);
      });
      const withCash = await count(sql`select count(*)::int as n from futbolsa.wallets where season_id = ${s.seasonId} and cash <> 0`);
      const [a, b] = await Promise.all([closeRoute(s, scene.admin), closeRoute(s, second), scene.close(s.seasonId, C), settle.settlePending()]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses, `rodada ${round}: ${a.body} | ${b.body}`).toEqual([200, 409]);
      const refused = a.statusCode === 409 ? a : b;
      expect(refused.json().code).toBe("season_closed");

      // um registro do encerramento, um histórico por jogador, um anual, um dezembro, uma linha season_close por carteira
      expect(await count(sql`select count(*)::int as n from futbolsa.admin_log where action = 'season.close' and target_id = ${String(s.seasonId)}`)).toBe(1);
      expect(await count(sql`select count(*)::int as n from futbolsa.season_results where season_id = ${s.seasonId}`)).toBe(5);
      const snaps = await t.db.select().from(rankingSnapshots).where(eq(rankingSnapshots.seasonId, s.seasonId));
      expect(snaps.filter((x) => x.period === "season")).toHaveLength(1);
      expect(snaps.filter((x) => x.period === "month" && x.periodKey === "2027-12")).toHaveLength(1);
      const keys = snaps.map((x) => `${x.period}|${x.periodKey}|${x.version}`);
      expect(new Set(keys).size).toBe(keys.length);
      const closes = await count(sql`
        select count(*)::int as n from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
        where w.season_id = ${s.seasonId} and e.kind = 'season_close'`);
      expect(closes).toBe(withCash);
      expect(
        await count(sql`
          select count(*)::int as n from (select e.wallet_id from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
          where w.season_id = ${s.seasonId} and e.kind = 'season_close' group by e.wallet_id having count(*) > 1) x`),
      ).toBe(0);
      const results = await t.db.select().from(seasonResults).where(eq(seasonResults.seasonId, s.seasonId));
      expect(results.find((r) => r.position === null)).toBeDefined();
      await assertClosedSeasonEmpty(s);
    }
  }, 120_000);

  it("o encerramento e a aprovação da última recompra ao mesmo tempo: ou o encerramento recusa com a lista, ou passa com tudo liquidado", async () => {
    const outcomes: string[] = [];
    for (let round = 1; round <= 4; round++) {
      let ana = 0;
      const s = await ended(
        async (season) => {
          ana = await scene.player(season);
          await scene.buy(season, ana, "FLA3", 1_000);
        },
        { approve: false },
      );
      // tudo aprovado menos a recompra do FLA3
      clock.set(after(REGISTERED, 20));
      const fla = await scene.buybackOf(s, "FLA3");
      const others = (await t.db.select().from(payoutEvents).where(and(eq(payoutEvents.seasonId, s.seasonId), eq(payoutEvents.status, "pending"), ne(payoutEvents.id, fla.id)))).map((e) => e.id);
      await approver.approve(scene.admin.id, { eventIds: others });
      for (const id of others) await settle.settleEvent(id);
      await settle.whenIdle();

      clock.set(C);
      const [approval, closing] = await Promise.allSettled([
        sleep(round % 2 === 0 ? 20 : 0).then(async () => {
          const r = await approver.approve(second.id, { eventIds: [fla.id] });
          await settle.settleEvent(fla.id);
          return r;
        }),
        closeRoute(s),
      ]);
      await settle.whenIdle();
      expect(closing.status).toBe("fulfilled");
      const res = (closing as PromiseFulfilledResult<Awaited<ReturnType<typeof closeRoute>>>).value;
      if (res.statusCode === 200) {
        // passou: a aprovação e a liquidação inteira vieram antes da trava do encerramento
        expect(approval.status).toBe("fulfilled");
        outcomes.push("aprovou, liquidou e encerrou");
        await assertClosedSeasonEmpty(s);
      } else {
        expect(res.statusCode, res.body).toBe(409);
        const codes = res.json().blockers.map((x: { code: string }) => x.code);
        expect(codes.length).toBeGreaterThan(0);
        expect(codes.every((c: string) => ["buyback_not_approved", "payouts_pending", "payouts_settling", "shares_remaining"].includes(c))).toBe(true);
        outcomes.push(`recusou (${codes.join(", ")})`);
        expect(approval.status).toBe("fulfilled");
        // com a recompra liquidada, o encerramento seguinte passa
        await settle.whenIdle();
        const again = await closeRoute(s, scene.admin, after(C, 1));
        expect(again.statusCode, again.body).toBe(200);
        await assertClosedSeasonEmpty(s);
      }
      expect(await scene.cashOf(ana)).toBe(0);
      expect((await scene.creditsOf(fla.id)).map((c) => c.walletId)).toEqual([ana]);
    }
    console.log(`[T10] encerramento × aprovação: ${outcomes.join("; ")}`);
  }, 120_000);

  it(`o encerramento com ${SCALE_WALLETS} carteiras: mede o tempo da transação e confere as invariantes`, async () => {
    const s = await ended(async () => {});
    const tag = `s${s.seasonId}`;
    // as carteiras em lote, por SQL: usuários, carteiras com caixa diferente em cada uma, a linha inicial e algumas linhas
    // de ajuste espalhadas pelos meses (o extrato fica como o post o gravaria: cash_after é a soma até a linha)
    let started = performance.now();
    await t.db.execute(sql`
      insert into futbolsa.users (email, nickname, terms_accepted_at)
      select ${tag} || '_carga_' || g || '@exemplo.com', ${tag} || '_carga_' || g, ${T0.toISOString()}::timestamptz
      from generate_series(1, ${SCALE_WALLETS}) g`);
    await t.db.execute(sql`
      insert into futbolsa.wallets (season_id, owner_type, user_id, cash, entered_at, entry_mode)
      select ${s.seasonId}, 'user', u.id,
        10000000 + (row_number() over (order by u.id) % 997) * 100 + ${SCALE_ENTRIES * 1_000},
        ${T0.toISOString()}::timestamptz, 'ipo'
      from futbolsa.users u where u.nickname like ${tag + "_carga_%"}`);
    await t.db.execute(sql`
      insert into futbolsa.wallet_entries (wallet_id, at, kind, cash_delta, cash_after)
      select w.id, ${T0.toISOString()}::timestamptz, 'initial', w.cash - ${SCALE_ENTRIES * 1_000}, w.cash - ${SCALE_ENTRIES * 1_000}
      from futbolsa.wallets w join futbolsa.users u on u.id = w.user_id
      where w.season_id = ${s.seasonId} and u.nickname like ${tag + "_carga_%"}`);
    await t.db.execute(sql`
      insert into futbolsa.wallet_entries (wallet_id, at, kind, cash_delta, cash_after, reason)
      select w.id, ${T0.toISOString()}::timestamptz + k * interval '20 days', 'adjustment', 1000,
        w.cash - ${SCALE_ENTRIES * 1_000} + k * 1000, 'carga de teste'
      from futbolsa.wallets w join futbolsa.users u on u.id = w.user_id
      cross join generate_series(1, ${SCALE_ENTRIES}) k
      where w.season_id = ${s.seasonId} and u.nickname like ${tag + "_carga_%"}
      order by w.id, k`);
    await t.db.execute(sql`analyze`);
    const loadMs = performance.now() - started;
    const walletCount = await count(sql`select count(*)::int as n from futbolsa.wallets where season_id = ${s.seasonId}`);
    expect(walletCount).toBeGreaterThanOrEqual(SCALE_WALLETS);
    await assertLedgerConsistent(t.db, s.seasonId);
    const cashBefore = await totalCash(t.db, s.seasonId);

    // a tarefa do fim do mês já fechou março a novembro (como em produção), e o recálculo que ela pede já rodou
    started = performance.now();
    await app.get(CloseService, { strict: false }).runOnce(C);
    await app.get(RecalcService, { strict: false }).processRecalcRequests(C);
    const monthsMs = performance.now() - started;

    // o tempo de cada passo dentro da transação
    const steps = new Map<string, number>();
    /** Envolve o método da instância (o serviço que o encerramento recebe por injeção) e devolve como desfazer. */
    const timed = (target: object, method: string, label: string) => {
      const host = target as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = host[method]!.bind(target);
      host[method] = async (...args: unknown[]) => {
        const t0 = performance.now();
        try {
          return await original(...args);
        } finally {
          steps.set(label, (steps.get(label) ?? 0) + performance.now() - t0);
        }
      };
      // o método é do protótipo: apagar o da instância volta ao original
      return { mockRestore: () => delete host[method] };
    };
    const ranks = app.get(CloseService, { strict: false });
    const spies = [
      timed(ranks, "closeMonthsDue", "closeMonthsDue"),
      timed(ranks, "closeSeason", "closeSeason (dezembro e anual)"),
      timed(app.get(SeasonResultsService, { strict: false }), "record", "season_results"),
      timed(app.get(SnapshotService, { strict: false }), "takeSnapshots", "foto mensal"),
      timed(app.get(PortfolioLedger, { strict: false }), "postCashEach", "zerar (postCashEach)"),
    ];
    started = performance.now();
    const res = await closeRoute(s);
    const closeMs = performance.now() - started;
    for (const spy of spies) spy.mockRestore();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ wallets: walletCount, results: SCALE_WALLETS });

    const breakdown = [...steps].map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(", ");
    console.log(
      `[T10] ${walletCount} carteiras (${SCALE_ENTRIES + 1} linhas de extrato cada): carga ${(loadMs / 1000).toFixed(1)} s; meses pela tarefa ${(monthsMs / 1000).toFixed(1)} s; ` +
        `encerramento (POST, a transação inteira) ${(closeMs / 1000).toFixed(1)} s — ${breakdown}`,
    );

    // invariantes: o caixa que havia saiu todo pelas linhas season_close, uma por carteira
    const zeroed = await count(sql`
      select coalesce(-sum(e.cash_delta), 0)::bigint as n from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id
      where w.season_id = ${s.seasonId} and e.kind = 'season_close'`);
    expect(zeroed).toBe(cashBefore);
    expect(await count(sql`select count(*)::int as n from futbolsa.season_results where season_id = ${s.seasonId}`)).toBe(SCALE_WALLETS);
    const [annual] = await t.db.select().from(rankingSnapshots).where(and(eq(rankingSnapshots.seasonId, s.seasonId), eq(rankingSnapshots.period, "season")));
    expect(await count(sql`select count(*)::int as n from futbolsa.ranking_rows where snapshot_id = ${annual!.id}`)).toBe(SCALE_WALLETS);
    // o patrimônio final gravado é o caixa de antes de zerar (ninguém tem ação)
    expect(
      await count(sql`
        select count(*)::int as n from futbolsa.season_results r
        join futbolsa.wallets w on w.user_id = r.user_id and w.season_id = r.season_id
        join lateral (select e.cash_delta from futbolsa.wallet_entries e where e.wallet_id = w.id and e.kind = 'season_close') z on true
        where r.season_id = ${s.seasonId} and r.final_equity <> -z.cash_delta`),
    ).toBe(0);
    await assertClosedSeasonEmpty(s);
  }, 900_000);
});
