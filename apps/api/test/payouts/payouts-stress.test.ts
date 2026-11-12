import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as TransactionModule from "../../src/infra/db/transaction.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { orders, payoutEvents } from "../../src/infra/db/schema/index.js";
import { DomainError } from "../../src/infra/http/index.js";
import { ApplyCorrectionService } from "../../src/modules/admin/payouts/apply-correction.service.js";
import { ApproveService } from "../../src/modules/admin/payouts/approve.service.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { settlingEventIds } from "../../src/modules/admin/payouts/settlement.js";
import { CancelService, OrderService, type PlaceOrderInput, RefreshWaker } from "../../src/modules/market/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { rng, T0 } from "../support/fixtures.js";
import {
  assertLedgerConsistent,
  assertOpenOrdersCounter,
  assertReservesMatchOrders,
  assertSharesConserved,
  totalCash,
} from "../support/invariants.js";
import { after, correctionScene, PRICE, RICH, ROUND10_CLOSE, type Season, SilentWaker } from "./correction-scene.js";

// T8 do Plano dos dividendos e pagamentos: os pagamentos sob concorrência. Em 3 clubes (BOT3, CAM3, FLA3), em
// rajadas concorrentes (`Promise.all`, pool de 30 conexões), um sorteio com semente fixa de ordens limitadas e a
// mercado e de cancelamentos, junto com:
//   fase A: as aprovações da rodada 10 (dois admins aprovando o mesmo evento) e a liquidação em lotes pequenos (duas
//           liquidações do mesmo evento ao mesmo tempo, mais a tarefa de cada minuto);
//   fase B: a correção da rodada 10 (o CAM3 × BOT3 vira 1 × 1: estorno no CAM3, evento novo no BOT3) que deixa carteiras
//           negativas e cancela as compras delas, as aprovações da rodada 11 e as liquidações de tudo.
// No fim: nenhuma repetição por *deadlock* (nem erro que chegue a quem chamou); extrato igual às carteiras, ações
// conservadas, reservas iguais ao livro; nenhum caixa negativo com reserva; a variação do caixa de todas as carteiras
// é a soma dos créditos; e, por chave e carteira, a soma dos créditos de todas as versões é ações na foto vigente ×
// valor vigente.

/** Cada `withTransaction` do processo passa por aqui: conta as transações e as repetições por *deadlock*. */
const watch = vi.hoisted(() => ({ transactions: 0, retries: [] as string[] }));
vi.mock("../../src/infra/db/transaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TransactionModule>();
  const withTransaction: typeof actual.withTransaction = (db, fn, options = {}) => {
    watch.transactions++;
    return actual.withTransaction(db, fn, {
      ...options,
      onRetry: (attempt, code) => {
        watch.retries.push(`${code} (repetição ${attempt})`);
        options.onRetry?.(attempt, code);
      },
    });
  };
  return { ...actual, withTransaction };
});

const TICKERS = ["BOT3", "CAM3", "FLA3"] as const;
const SEED = 20261112;
/** Ações de cada jogador e bot do sorteio em cada um dos 3 clubes, compradas da tesouraria antes da rodada 10. */
const SHARES = 300;
/** Os donos de muito CAM3 e pouco caixa: o estorno de R$ 0,20 por ação os deixa negativos. */
const POOR = 4;
const POOR_CAM3 = 1_000;
/** O caixa de cada um deles depois da compra de PAL3 no começo da fase B (antes de dividendos da rodada 11). */
const POOR_CASH = 8_000;
const OPS_PER_BURST = 24;
const BURST_MS = 20_000;
const PHASE_A_BURSTS = 14;
const PHASE_B_BURSTS = 16;
/** Lotes pequenos: muitos lotes por evento, disputando as carteiras com as ordens. */
const BATCH = 4;
/** O preço de referência do túnel; as limitadas ficam a até 5% dele (nenhum leilão abre). */
const REF = 4_000;
const REASON = "placar do CAM3 × BOT3 corrigido na súmula";

const PHASE_A = after(ROUND10_CLOSE, 10);
/** A rodada 11 começa depois da fase A: a foto dela vem das ações negociadas na fase A. */
const ROUND11_KICKOFF = after(PHASE_A, 60);
const ROUND11_CLOSE = after(ROUND11_KICKOFF, 120);
const PHASE_B = after(ROUND11_CLOSE, 10);
const later = (at: Date, ms: number) => new Date(at.getTime() + ms);

describe("pagamentos sob concorrência: aprovações, correção, ordens e cancelamentos em 3 clubes", () => {
  const t = useTestDatabase(30);
  const clock = new FixedClock(ROUND10_CLOSE);
  let app: NestFastifyApplication;
  let approve: ApproveService;
  let settle: SettleCreditsService;
  let applier: ApplyCorrectionService;
  let orderService: OrderService;
  let cancels: CancelService;
  let otherAdmin: TestAccount;
  let s: Season;
  let traders: { walletId: number; actor: "player" | "bot" }[];
  let poor: number[];
  let cashBefore: number;
  const scene = correctionScene(() => t.db, () => app, clock);

  /** O que o sorteio e as operações fizeram, por tipo de resultado (o relatório no fim cita). */
  const counts = new Map<string, number>();
  const count = (key: string, n = 1) => counts.set(key, (counts.get(key) ?? 0) + n);
  /** Erros que chegaram a quem chamou, fora as recusas esperadas: o esperado é nenhum. */
  const failures: string[] = [];

  beforeAll(async () => {
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
    });
    approve = app.get(ApproveService, { strict: false });
    settle = app.get(SettleCreditsService, { strict: false });
    applier = app.get(ApplyCorrectionService, { strict: false });
    orderService = app.get(OrderService, { strict: false });
    cancels = app.get(CancelService, { strict: false });
    settle.batchSize = BATCH;
    await scene.init();
    otherAdmin = await createAccount(t.db, { role: "admin" });

    s = await scene.newSeason();
    for (const ticker of TICKERS) await scene.setLastPrice(s, ticker, REF);
    const players = await Promise.all(Array.from({ length: 16 }, () => scene.player(s, RICH)));
    const bots = [await scene.bot(s, RICH), await scene.bot(s, RICH)];
    traders = [...players.map((walletId) => ({ walletId, actor: "player" as const })), ...bots.map((walletId) => ({ walletId, actor: "bot" as const }))];
    for (const { walletId } of traders) for (const ticker of TICKERS) await scene.buy(s, walletId, ticker, SHARES, T0);
    poor = [];
    for (let i = 0; i < POOR; i++) {
      const w = await scene.player(s, POOR_CAM3 * PRICE);
      await scene.buy(s, w, "CAM3", POOR_CAM3, T0);
      poor.push(w);
    }
    cashBefore = await totalCash(t.db, s.seasonId);
  }, 120_000);
  afterAll(async () => {
    await settle?.whenIdle();
    await app?.close();
  });

  const price = (value: number) => Math.round(value / 10) * 10;

  /** Roda a operação e conta o erro que chegou a quem chamou; as recusas de domínio em `allowed` são esperadas. */
  async function guarded(label: string, op: () => Promise<void>, allowed: readonly string[] = []): Promise<void> {
    try {
      await op();
    } catch (error) {
      if (error instanceof DomainError && allowed.includes(error.code)) {
        count(`${label}: ${error.code}`);
        return;
      }
      failures.push(`${label}: ${(error as Error).message}`);
    }
  }

  async function cancellable(): Promise<{ id: number; walletId: number }[]> {
    return t.db
      .select({ id: orders.id, walletId: orders.walletId })
      .from(orders)
      .where(and(eq(orders.seasonId, s.seasonId), eq(orders.status, "open"), inArray(orders.walletId, traders.map((x) => x.walletId))));
  }

  /** Uma rajada: `OPS_PER_BURST` ordens e cancelamentos sorteados mais as operações de pagamento, todas juntas. */
  async function burst(random: () => number, now: Date, extra: (() => Promise<void>)[] = []): Promise<void> {
    clock.set(now);
    const open = await cancellable();
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const ops: (() => Promise<void>)[] = [];
    for (let i = 0; i < OPS_PER_BURST; i++) {
      const ticker = pick(TICKERS);
      const who = pick(traders);
      const roll = random();
      const side = random() < 0.5 ? "buy" : "sell";
      const base = { seasonId: s.seasonId, ticker, walletId: who.walletId, actor: who.actor, side, now } as const;
      if (roll < 0.6) {
        const input: PlaceOrderInput = { ...base, type: "limit", quantity: 1 + Math.floor(random() * 15), limitPrice: price(REF * (1 + (random() * 2 - 1) * 0.05)) };
        ops.push(() => placeCounted(input, `limitada ${side}`));
      } else if (roll < 0.72) {
        const input: PlaceOrderInput = { ...base, type: "market", quantity: 1 + Math.floor(random() * 8) };
        ops.push(() => placeCounted(input, `a mercado ${side}`));
      } else if (open.length > 0) {
        const target = pick(open);
        ops.push(() =>
          guarded("cancelamento", async () => {
            const r = await cancels.cancelOrder({ walletId: target.walletId, orderId: target.id, now });
            count(r.ok ? "cancelamento: cancelou" : `cancelamento: ${r.code}`);
          }),
        );
      }
    }
    await Promise.all([...ops, ...extra].map((op) => op()));
  }

  function placeCounted(input: PlaceOrderInput, kind: string): Promise<void> {
    return guarded(kind, async () => {
      const r = await orderService.place(input);
      count(r.ok ? `${kind}: aceita` : `${kind}: ${"auctionExpired" in r ? "leilão vencido" : r.code}`);
    });
  }

  /** Aprova um evento (às vezes os dois admins ao mesmo tempo) e liquida (às vezes duas liquidações juntas). */
  function approveAndSettle(eventId: number, twice: boolean): () => Promise<void> {
    return () =>
      guarded("aprovação", async () => {
        const admins = twice ? [scene.admin.id, otherAdmin.id] : [scene.admin.id];
        const responses = await Promise.all(admins.map((a) => approve.approve(a, { eventIds: [eventId] })));
        for (const r of responses) count(`aprovação: ${r.results[0]!.outcome}`);
        await Promise.all((twice ? [0, 1] : [0]).map(() => settle.settleEvent(eventId)));
      });
  }

  const settleTask = () => () =>
    guarded("tarefa de liquidação", async () => void count(`tarefa de liquidação: ${(await settle.settlePending()).credited > 0 ? "creditou" : "nada a creditar"}`));

  /** Liquida o que sobrou (a tarefa de cada minuto) até nada faltar. */
  async function drain(): Promise<void> {
    await settle.whenIdle();
    for (let i = 0; i < 5; i++) {
      const summary = await settle.settlePending();
      expect(summary.errors).toEqual([]);
      if ((await settlingEventIds(t.db, s.seasonId)).length === 0) return;
    }
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([]);
  }

  const pendingIds = async () =>
    (
      await t.db
        .select({ id: payoutEvents.id })
        .from(payoutEvents)
        .where(and(eq(payoutEvents.seasonId, s.seasonId), eq(payoutEvents.status, "pending")))
        .orderBy(payoutEvents.id)
    ).map((r) => r.id);

  async function assertMoney(label: string): Promise<void> {
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
    await assertOpenOrdersCounter(t.db, s.seasonId);
    await assertReservesMatchOrders(t.db, s.seasonId);
    // nenhum caixa negativo com reserva (o `assertLedgerConsistent` já recusa; aqui, explícito)
    const { rows: negativeReserved } = await t.db.execute(
      sql`select id, cash, reserved_cash from futbolsa.wallets where season_id = ${s.seasonId} and cash < 0 and reserved_cash <> 0`,
    );
    expect(negativeReserved, label).toEqual([]);
    // a variação do caixa de todas as carteiras (a tesouraria junto) é a soma dos créditos
    const { rows } = await t.db.execute(sql`
      select coalesce(sum(c.amount), 0)::bigint as credited from futbolsa.payout_credits c
      join futbolsa.payout_events e on e.id = c.event_id where e.season_id = ${s.seasonId}`);
    expect((await totalCash(t.db, s.seasonId)) - cashBefore, label).toBe(Number(rows[0]!.credited));
    // por chave e carteira: a soma dos créditos de todas as versões é ações na foto vigente × valor vigente (os
    // pendentes ainda não pagaram nada, e nenhuma chave tem crédito sem versão aprovada)
    const { rows: wrong } = await t.db.execute(sql`
      with current as (
        select e.id, e.club_id, e.event_key, e.per_share from futbolsa.payout_events e
        where e.season_id = ${s.seasonId} and e.status = 'approved'),
      due as (
        select c.club_id, c.event_key, h.wallet_id, (h.shares::bigint * c.per_share) as due
        from current c join futbolsa.payout_holdings h on h.event_id = c.id),
      paid as (
        select e.club_id, e.event_key, pc.wallet_id, sum(pc.amount)::bigint as paid
        from futbolsa.payout_credits pc join futbolsa.payout_events e on e.id = pc.event_id
        where e.season_id = ${s.seasonId}
        group by e.club_id, e.event_key, pc.wallet_id)
      select coalesce(d.club_id, p.club_id) as club_id, coalesce(d.event_key, p.event_key) as key,
        coalesce(d.wallet_id, p.wallet_id) as wallet_id, coalesce(d.due, 0) as due, coalesce(p.paid, 0) as paid
      from due d full join paid p on p.club_id = d.club_id and p.event_key = d.event_key and p.wallet_id = d.wallet_id
      where coalesce(d.due, 0) <> coalesce(p.paid, 0)`);
    expect(wrong, label).toEqual([]);
  }

  it(
    "T8: aprovações, uma correção que deixa carteiras negativas, ordens e cancelamentos ao mesmo tempo conservam o dinheiro",
    async () => {
      const random = rng(SEED);
      const startedAt = Date.now();

      // ---- a rodada 10 fecha: os eventos pendentes ----
      await scene.insertMatches(scene.round10(s.seasonId));
      await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
      const round10 = await pendingIds();
      expect(round10.length).toBeGreaterThanOrEqual(3);

      // ---- fase A: as aprovações e as liquidações da rodada 10 no meio das ordens ----
      for (let b = 0; b < PHASE_A_BURSTS; b++) {
        const extra: (() => Promise<void>)[] = [];
        // a partir da 2ª rajada, um a três eventos por rajada
        if (b >= 1) for (const id of round10.splice(0, 1 + Math.floor(random() * 3))) extra.push(approveAndSettle(id, random() < 0.5));
        if (b % 3 === 2) extra.push(settleTask());
        await burst(random, later(PHASE_A, b * BURST_MS), extra);
      }
      expect(round10).toEqual([]);
      await drain();
      await assertMoney("fim da fase A");
      expect(await pendingIds()).toEqual([]);

      // ---- a rodada 11 (a foto sai das ações negociadas na fase A) e a correção da rodada 10 ----
      await scene.insertMatches([
        scene.game(s.seasonId, 11, "CAM3", "FLA3", [0, 1], ROUND11_KICKOFF),
        scene.game(s.seasonId, 11, "BOT3", "SAO3", [1, 1], ROUND11_KICKOFF),
      ]);
      await scene.close(s.seasonId, after(ROUND11_CLOSE, 3));
      const round11 = await pendingIds();
      expect(round11.length).toBeGreaterThanOrEqual(3);
      await scene.setScore(s.seasonId, "CAM3", [1, 1]);

      // os donos de muito CAM3 gastam o caixa (PAL3 da tesouraria) e deixam compras abertas no BOT3 e no FLA3
      clock.set(PHASE_B);
      const poorBuys: number[] = [];
      for (const w of poor) {
        const spend = (await scene.cashOf(w)) - POOR_CASH;
        await scene.buy(s, w, "PAL3", spend / PRICE, PHASE_B);
        poorBuys.push(await scene.placeOk(s, w, "BOT3", "buy", 1, price(REF * 0.91), PHASE_B));
        poorBuys.push(await scene.placeOk(s, w, "FLA3", "buy", 1, price(REF * 0.91), PHASE_B));
      }
      let plan = await scene.plan(s.seasonId, PHASE_B);
      expect(plan.preview.wallets.negative).toBeGreaterThanOrEqual(POOR);
      expect(plan.preview.wallets.buysCancelled).toBeGreaterThanOrEqual(POOR * 2);
      expect(plan.preview.changes.map((c) => [c.club.ticker, c.outcome])).toEqual([
        ["BOT3", "new_in_paid_group"],
        ["CAM3", "correction"],
      ]);

      // ---- fase B: a correção, as aprovações da rodada 11 e as liquidações no meio das ordens ----
      let applied: number[] | null = null;
      let applyAttempts = 0;
      for (let b = 0; b < PHASE_B_BURSTS; b++) {
        const now = later(PHASE_B, (b + 1) * BURST_MS);
        const extra: (() => Promise<void>)[] = [];
        if (b >= 1) for (const id of round11.splice(0, 1 + Math.floor(random() * 2))) extra.push(approveAndSettle(id, random() < 0.5));
        if (applied === null && b >= 2) {
          // a prévia de novo quando a anterior ficou velha (uma aprovação da rodada 11 liquidando no meio)
          if (applyAttempts > 0) {
            await drain();
            plan = await scene.plan(s.seasonId, now);
          }
          const code = plan.planCode;
          applyAttempts++;
          extra.push(() =>
            guarded(
              "correção",
              async () => {
                const result = await applier.apply(scene.admin.id, { planCode: code, reason: REASON });
                applied = result.events.map((e) => e.eventId);
                count("correção: aplicada");
                await settle.settlePending();
              },
              ["correction_stale", "payout_settling"],
            ),
          );
        } else if (applied !== null) {
          // as versões novas liquidadas de novo, duas vezes ao mesmo tempo (a outra instância da API)
          for (const id of applied as number[]) extra.push(() => guarded("liquidação da correção", async () => void (await Promise.all([settle.settleEvent(id), settle.settleEvent(id)]))));
        }
        if (b % 4 === 3) extra.push(settleTask());
        await burst(random, now, extra);
      }
      expect(applied, `a correção não foi aplicada em ${applyAttempts} tentativas`).not.toBeNull();
      expect(round11).toEqual([]);
      await drain();

      // ---- o fim ----
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const report = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `  ${k}: ${v}`);
      const { rows: tradeRows } = await t.db.execute(sql`select count(*)::int as n from futbolsa.trades where season_id = ${s.seasonId}`);
      console.info(
        [
          `T8: ${PHASE_A_BURSTS + PHASE_B_BURSTS} rajadas em ${elapsed} s; ${watch.transactions} transações; negócios ${tradeRows[0]!.n}; correção em ${applyAttempts} tentativa(s)`,
          ...report,
          `  repetições por deadlock: ${watch.retries.length}`,
        ].join("\n"),
      );

      expect(failures).toEqual([]);
      expect(watch.transactions).toBeGreaterThan(500);
      expect(watch.retries).toEqual([]);
      await assertMoney("fim da fase B");

      // a correção deixou os donos de muito CAM3 negativos, sem nada reservado, com as compras canceladas pelo estorno
      for (const w of poor) {
        const wallet = await scene.walletOf(w);
        expect(wallet.cash, `carteira ${w}`).toBeLessThan(0);
        expect(wallet.reservedCash).toBe(0);
        expect(await scene.entriesOf(w, ["reversal"])).toHaveLength(1);
      }
      for (const id of poorBuys) {
        const order = await scene.orderOf(id);
        // a compra pode ter sido executada pelo sorteio antes do estorno; aberta, ela não fica
        expect(order.status === "filled" || (order.status === "cancelled" && order.cancelReason === "reversal"), `ordem ${id}: ${order.status}`).toBe(true);
      }
      const cam = await scene.eventsOf(s.seasonId, "CAM3");
      expect(cam.filter((e) => e.eventKey === "points|brasileirao-a|10|CAM3").map((e) => [e.version, e.status, e.perShare])).toEqual([
        [1, "superseded", 30],
        [2, "approved", 10],
      ]);
      expect((await scene.paidByKey(s.seasonId, "CAM3")).get(poor[0]!)).toBe(POOR_CAM3 * 10);
      // o sorteio cobriu o que a T8 pede
      const accepted = [...counts].filter(([k]) => k.endsWith(": aceita")).reduce((sum, [, v]) => sum + v, 0);
      expect(accepted).toBeGreaterThan(300);
      expect(counts.get("cancelamento: cancelou") ?? 0).toBeGreaterThan(50);
      expect(counts.get("aprovação: already_approved") ?? 0).toBeGreaterThan(0);
      const { rows: reversals } = await t.db.execute(sql`
        select count(*)::int as n from futbolsa.orders where season_id = ${s.seasonId} and cancel_reason = 'reversal'`);
      expect(Number(reversals[0]!.n)).toBeGreaterThanOrEqual(1);
      expect(await pendingIds()).toEqual([]);
    },
    300_000,
  );
});
