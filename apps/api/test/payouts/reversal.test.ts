import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockClubs, lockSeason, lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { ORDER_CANCEL_REASONS, type OrderCancelReason, positions } from "../../src/infra/db/schema/index.js";
import { ApplyCorrectionService } from "../../src/modules/admin/payouts/apply-correction.service.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { SettleReversalService } from "../../src/modules/admin/payouts/settle-reversal.js";
import { openOrderTickers, RefreshWaker } from "../../src/modules/market/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { after, CALLS, correctionScene, prepareCalls, PRICE, RecordingRankings, RICH, ROUND10_CLOSE, type Season, SilentWaker } from "./correction-scene.js";

const REASON = "placar do CAM3 × BOT3 corrigido na súmula";

describe("estorno com cancelamento das compras e caixa negativo (T7)", () => {
  const t = useTestDatabase(12);
  const clock = new FixedClock(ROUND10_CLOSE);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  let applier: ApplyCorrectionService;
  let settle: SettleCreditsService;
  let reversal: SettleReversalService;
  const scene = correctionScene(() => t.db, () => app, clock);

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
    });
    applier = app.get(ApplyCorrectionService, { strict: false });
    settle = app.get(SettleCreditsService, { strict: false });
    reversal = app.get(SettleReversalService, { strict: false });
    await scene.init();
  });
  afterAll(async () => {
    await settle?.whenIdle();
    await app?.close();
  });
  beforeEach(async () => {
    await settle.whenIdle();
    reversal.hooks = {};
    rankings.reset();
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  /** O instante das ordens: depois do fechamento e do pagamento da rodada 10, antes da correção. */
  const ORDERS_AT = after(ROUND10_CLOSE, 40);
  const NOW = after(ROUND10_CLOSE, 60);

  /**
   * A rodada 10 paga (CAM3 2 × 1 BOT3, R$ 0,30 por ação do CAM3) com Bruno dono de 2.000 CAM3 e o caixa dado depois do
   * dividendo; o placar vira 1 × 1 (estorno de R$ 0,20 por ação, R$ 400,00 de Bruno). `setup` monta as ordens antes da
   * correção.
   */
  async function scenario(cashAfterDividend: number, setup: (s: Season, bruno: number) => Promise<void> = async () => undefined) {
    const s = await scene.newSeason();
    const bruno = await scene.player(s, 2_000 * PRICE);
    await scene.buy(s, bruno, "CAM3", 2_000);
    await scene.insertMatches(scene.round10(s.seasonId));
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await scene.approveAll(after(ROUND10_CLOSE, 5));
    expect(await scene.cashOf(bruno)).toBe(60_000);
    // o caixa de Bruno antes da correção: gasta (ou ganha) a diferença com a tesouraria em FLA3
    if (cashAfterDividend < 60_000) await scene.buy(s, bruno, "FLA3", (60_000 - cashAfterDividend) / PRICE, after(ROUND10_CLOSE, 30));
    expect(await scene.cashOf(bruno)).toBe(cashAfterDividend);
    await setup(s, bruno);
    await scene.setScore(s.seasonId, "CAM3", [1, 1]);
    return { s, bruno };
  }

  const applyAndSettle = async (s: Season) => {
    const p = await scene.plan(s.seasonId, NOW);
    clock.set(NOW);
    await applier.apply(scene.admin.id, { planCode: p.planCode, reason: REASON });
    const summary = await settle.settlePending();
    expect(summary.errors).toEqual([]);
    return p;
  };

  it("admin 15: com R$ 500,00 reservados numa compra, o estorno de R$ 400,00 cancela a compra e deixa R$ 100,00", async () => {
    let buyId = 0;
    let sellId = 0;
    const { s, bruno } = await scenario(50_000, async (season, wallet) => {
      await scene.setLastPrice(season, "PAL3", 5_000);
      buyId = await scene.placeOk(season, wallet, "PAL3", "buy", 10, 5_000, ORDERS_AT);
      // e uma venda aberta de CAM3, que fica
      sellId = await scene.placeOk(season, wallet, "CAM3", "sell", 100, 4_800, ORDERS_AT);
    });
    expect(await scene.walletOf(bruno)).toMatchObject({ cash: 50_000, reservedCash: 50_000, openOrders: 2 });

    const p = await applyAndSettle(s);
    expect(p.preview.wallets).toMatchObject({ pay: 1, negative: 0, buysCancelled: 1 });

    expect(await scene.walletOf(bruno)).toMatchObject({ cash: 10_000, reservedCash: 0, openOrders: 1 });
    expect(await scene.orderOf(buyId)).toMatchObject({ status: "cancelled", cancelReason: "reversal", reservedCash: 0 });
    expect(await scene.orderOf(sellId)).toMatchObject({ status: "open" });
    const [position] = await t.db.select().from(positions).where(and(eq(positions.walletId, bruno), eq(positions.clubId, scene.club("CAM3"))));
    expect(position).toMatchObject({ shares: 2_000, reservedShares: 100 });
    // a reserva volta antes do estorno
    const entries = await scene.entriesOf(bruno, ["order_release", "reversal"]);
    expect(entries.map((e) => [e.kind, e.cashDelta, e.reservedCashDelta, e.cashAfter])).toEqual([
      ["order_release", 0, -50_000, 50_000],
      ["reversal", -40_000, 0, 10_000],
    ]);
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("caixa livre que cobre o estorno não cancela nada", async () => {
    let buyId = 0;
    const { s, bruno } = await scenario(60_000, async (season, wallet) => {
      await scene.setLastPrice(season, "PAL3", 5_000);
      // R$ 100,00 reservados; o caixa livre (R$ 500,00) cobre os R$ 400,00
      buyId = await scene.placeOk(season, wallet, "PAL3", "buy", 2, 5_000, ORDERS_AT);
    });
    const p = await applyAndSettle(s);
    expect(p.preview.wallets.buysCancelled).toBe(0);
    expect(await scene.orderOf(buyId)).toMatchObject({ status: "open", reservedCash: 10_000 });
    expect(await scene.walletOf(bruno)).toMatchObject({ cash: 20_000, reservedCash: 10_000, openOrders: 1 });
  });

  it("vendas abertas ficam: o caixa fica negativo, sem nada reservado, com a venda no livro", async () => {
    let sellId = 0;
    const { s, bruno } = await scenario(15_000, async (season, wallet) => {
      sellId = await scene.placeOk(season, wallet, "CAM3", "sell", 300, 4_500, ORDERS_AT);
    });
    await applyAndSettle(s);
    expect(await scene.walletOf(bruno)).toMatchObject({ cash: -25_000, reservedCash: 0, openOrders: 1 });
    expect(await scene.orderOf(sellId)).toMatchObject({ status: "open", reservedCash: 0 });
    const [position] = await t.db.select().from(positions).where(and(eq(positions.walletId, bruno), eq(positions.clubId, scene.club("CAM3"))));
    expect(position).toMatchObject({ reservedShares: 300 });
  });

  it("admin 14: com −R$ 250,00 a compra é recusada e a venda de 100 CAM3 a R$ 20,00 leva o caixa a R$ 1.750,00", async () => {
    const { s, bruno } = await scenario(15_000);
    await applyAndSettle(s);
    expect(await scene.cashOf(bruno)).toBe(-25_000);

    const later = after(NOW, 10);
    const refused = await scene.place(s, bruno, "PAL3", "buy", 1, 4_000, later);
    expect(refused).toMatchObject({ ok: false, code: "negative_cash" });

    // alguém compra 100 CAM3 a R$ 20,00 (o preço exibido do CAM3 caiu para R$ 20,00) e Bruno vende para ele
    await scene.setLastPrice(s, "CAM3", 2_000);
    const ana = await scene.player(s, RICH);
    await scene.placeOk(s, ana, "CAM3", "buy", 100, 2_000, later);
    const sold = await scene.place(s, bruno, "CAM3", "sell", 100, 2_000, after(later, 1));
    expect(sold.ok).toBe(true);
    expect(await scene.cashOf(bruno)).toBe(175_000);
    await assertLedgerConsistent(t.db, s.seasonId);
  });

  it("compra aberta que aparece num clube novo entre a leitura e a trava faz a transação recomeçar", async () => {
    let first = 0;
    let late = 0;
    const attempts: number[] = [];
    const { s, bruno } = await scenario(60_000, async (season, wallet) => {
      await scene.setLastPrice(season, "PAL3", 5_000);
      first = await scene.placeOk(season, wallet, "PAL3", "buy", 10, 5_000, ORDERS_AT);
    });
    reversal.hooks = {
      afterClubsRead: async (walletId, attempt) => {
        if (walletId !== bruno) return;
        attempts.push(attempt);
        // entre a leitura dos clubes (sem trava) e a trava: uma compra nova em SAO3, clube que a transação não lê
        if (attempt === 0) late = await scene.placeOk(s, bruno, "SAO3", "buy", 2, 4_000, after(ORDERS_AT, 1));
      },
    };
    await applyAndSettle(s);

    expect(attempts).toEqual([0, 1]);
    expect(await scene.orderOf(first)).toMatchObject({ status: "cancelled", cancelReason: "reversal" });
    expect(await scene.orderOf(late)).toMatchObject({ status: "cancelled", cancelReason: "reversal" });
    expect(await scene.walletOf(bruno)).toMatchObject({ cash: 20_000, reservedCash: 0, openOrders: 0 });
    expect(await scene.entriesOf(bruno, ["reversal"])).toHaveLength(1);
  });

  it("depois de 3 recomeços, a transação trava todos os clubes da temporada", async () => {
    const attempts: number[] = [];
    const late: number[] = [];
    const { s, bruno } = await scenario(60_000, async (season, wallet) => {
      await scene.setLastPrice(season, "PAL3", 5_000);
      await scene.placeOk(season, wallet, "PAL3", "buy", 5, 5_000, ORDERS_AT);
    });
    const newClubs = ["SAO3", "COR3", "FLU3"];
    reversal.hooks = {
      afterClubsRead: async (walletId, attempt) => {
        if (walletId !== bruno) return;
        attempts.push(attempt);
        const ticker = newClubs[attempt];
        if (ticker) late.push(await scene.placeOk(s, bruno, ticker, "buy", 1, 4_000, after(ORDERS_AT, attempt + 1)));
      },
    };
    await applyAndSettle(s);
    expect(attempts).toEqual([0, 1, 2, 3]);
    for (const id of late) expect(await scene.orderOf(id)).toMatchObject({ status: "cancelled", cancelReason: "reversal" });
    expect(await scene.walletOf(bruno)).toMatchObject({ cash: 20_000, reservedCash: 0, openOrders: 0 });
  });

  /** Uma carteira com duas compras abertas (R$ 100,00 reservados) e uma venda, num cenário sem correção. */
  async function walletWithOrders() {
    const s = await scene.newSeason();
    const w = await scene.player(s, 30_000);
    await scene.buy(s, w, "CAM3", 100);
    await scene.setLastPrice(s, "PAL3", 5_000);
    await scene.setLastPrice(s, "SAO3", 5_000);
    const buys = [await scene.placeOk(s, w, "PAL3", "buy", 1, 5_000, ORDERS_AT), await scene.placeOk(s, w, "SAO3", "buy", 1, 5_000, ORDERS_AT)];
    const sell = await scene.placeOk(s, w, "CAM3", "sell", 50, 4_000, ORDERS_AT);
    return { s, w, buys, sell };
  }

  /** Chama o `cancelBuysToCover` como a F14 chamará: os clubes das ordens e a carteira travados antes. */
  const cancelToCover = (s: Season, w: number, toReturn: number, reason: OrderCancelReason) =>
    withTransaction(t.db, async (tx) => {
      await lockSeason(tx, s.seasonId, "share");
      await lockClubs(tx, s.seasonId, await openOrderTickers(tx, w, { side: "buy" }));
      await lockWallets(tx, [w]);
      return reversal.cancelBuysToCover(tx, w, toReturn, reason);
    });

  it("cancelBuysToCover grava o motivo recebido e devolve a reserva; com o caixa livre cobrindo, não cancela", async () => {
    const { s, w, buys, sell } = await walletWithOrders();
    expect(await scene.walletOf(w)).toMatchObject({ cash: 20_000, reservedCash: 10_000 });
    // o caixa livre (R$ 100,00) cobre R$ 100,00: nada muda
    expect((await cancelToCover(s, w, 10_000, "blocked")).orders).toEqual([]);
    for (const id of buys) expect(await scene.orderOf(id)).toMatchObject({ status: "open" });

    // R$ 100,01 não cabe: todas as compras saem com o motivo dado, a venda fica
    const out = await cancelToCover(s, w, 10_001, "blocked");
    expect(out.orders.map((o) => o.id)).toEqual(buys);
    for (const id of buys) expect(await scene.orderOf(id)).toMatchObject({ status: "cancelled", cancelReason: "blocked", reservedCash: 0 });
    expect(await scene.orderOf(sell)).toMatchObject({ status: "open" });
    expect(await scene.walletOf(w)).toMatchObject({ cash: 20_000, reservedCash: 0, openOrders: 1 });
  });

  // `annulment` entra em `orders.cancel_reason` pela migração da F14 (T6 dela): até lá o banco recusa o valor
  it.skipIf(!(ORDER_CANCEL_REASONS as readonly string[]).includes("annulment"))(
    "cancelBuysToCover com o motivo annulment grava esse motivo e devolve a reserva (o caminho que a F14 usa)",
    async () => {
      const { s, w, buys } = await walletWithOrders();
      await cancelToCover(s, w, 1_000_000, "annulment" as OrderCancelReason);
      for (const id of buys) expect(await scene.orderOf(id)).toMatchObject({ status: "cancelled", cancelReason: "annulment", reservedCash: 0 });
      expect(await scene.walletOf(w)).toMatchObject({ reservedCash: 0 });
    },
  );
});
