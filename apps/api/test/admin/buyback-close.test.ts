import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { orders, payoutEvents, positions, wallets } from "../../src/infra/db/schema/index.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { after, CALLS, LISTED, prepareCalls, RecordingRankings, RICH, SilentWaker } from "../payouts/correction-scene.js";
import { A_END, at, BUYBACKS, buybackScene, FINAL_END, REGISTERED, TITLES } from "./buyback-scene.js";

describe("fechamento da recompra (F15, T3)", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(REGISTERED);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  const scene = buybackScene(() => t.db, () => app, clock);

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
  afterAll(() => app?.close());
  beforeEach(async () => {
    rankings.reset();
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  const holdersOf = async (eventId: number) => (await scene.holdingsOf(eventId)).map((h) => [h.walletId, h.shares]);

  it("dividendos 19: com a Série A fechada em 2027-12-05 e a final em 2027-12-19, a negociação continua até o jogo registrar o fim da final", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    await scene.buy(s, ana, "FLA3", 1_200);
    const m = await scene.seasonEnd(s, { cdb: { home: "FLA3", away: "out3", score: null } });

    // a Série A fecha, a final ainda não: nada fecha, a negociação continua
    await scene.close(s.seasonId, after(A_END, 10));
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading", tradingEndedAt: null });
    expect(await scene.buybacksOf(s)).toEqual([]);
    // às 18h10 do dia da final, o placar ainda não chegou
    await scene.close(s.seasonId, at("2027-12-19T21:10:00Z"));
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading", tradingEndedAt: null });
    expect(await scene.buybacksOf(s)).toEqual([]);

    // o placar chega às 18h15: a recompra de todos os clubes fecha nesse instante, e não no apito (18h)
    await scene.registerFinal(m, [1, 0]);
    const summary = await scene.close(s.seasonId, REGISTERED);
    expect(summary.errors).toEqual([]);
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading_ended", tradingEndedAt: REGISTERED });
    const events = await scene.buybacksOf(s);
    expect(events).toHaveLength(LISTED.length);
    for (const e of events) {
      expect(e).toMatchObject({ kind: "buyback", status: "pending", version: 1, closedAt: REGISTERED, competition: null, round: null, phase: null });
      expect(e.reason).toBe("recompra, fim da temporada: final da Copa do Brasil às 18h de 19/12/2027 (1,5× os dividendos da temporada)");
    }
    // e uma ordem nova de qualquer clube é recusada
    const refused = await scene.place(s, ana, "PAL3", "buy", 1, 4_000, after(REGISTERED, 1));
    expect(refused).toMatchObject({ ok: false, code: "market_closed" });
    // o aviso aos rankings saiu na transação, com D, e o wake() depois do COMMIT
    expect(rankings.changes.at(-1)).toEqual({ seasonId: s.seasonId, closedAts: [REGISTERED] });
    expect(rankings.wakes.at(-1)!.visible).toBe(rankings.wakes.at(-1)!.recorded);
  });

  it("dividendos 29: o negócio feito entre o apito e o registro do fim da final entra na foto de quem comprou", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    const bruno = await scene.player(s);
    await scene.buy(s, ana, "FLA3", 1_200);
    const m = await scene.seasonEnd(s, { cdb: { home: "FLA3", away: "out3", score: null } });
    await scene.close(s.seasonId, after(A_END, 10));
    // a final termina às 18h; às 18h10 Ana vende 100 FLA3 a Bruno; o placar chega às 18h15
    await scene.transfer(ana, bruno, "FLA3", 100, at("2027-12-19T21:10:00Z"));
    await scene.registerFinal(m, [1, 0]);
    await scene.close(s.seasonId, REGISTERED);

    const buyback = await scene.buybackOf(s, "FLA3");
    expect(buyback.perShare).toBe(BUYBACKS.FLA3);
    expect(await holdersOf(buyback.id)).toEqual([
      [ana, 1_100],
      [bruno, 100],
    ]);
    // o título da final vai para quem tinha a ação às 18h
    const [title] = (await scene.currentOf(s.seasonId, "FLA3")).filter((e) => e.kind === "cup_title");
    expect(title).toMatchObject({ perShare: TITLES.cdb, closedAt: FINAL_END, status: "pending" });
    expect(await holdersOf(title!.id)).toEqual([[ana, 1_200]]);
  });

  it("dividendos 20: Ana com compra de PAL3 e venda de FLA3 abertas tem as duas canceladas com as reservas devolvidas, a casa para e uma ordem nova é recusada", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s, RICH);
    await scene.buy(s, ana, "FLA3", 1_200);
    const m = await scene.seasonEnd(s, { cdb: { home: "FLA3", away: "out3", score: null } });
    await scene.setLastPrice(s, "PAL3", 4_000);
    await scene.setLastPrice(s, "FLA3", 4_000);
    const when = after(A_END, 60);
    const buyId = await scene.placeOk(s, ana, "PAL3", "buy", 10, 4_000, when);
    const sellId = await scene.placeOk(s, ana, "FLA3", "sell", 100, 4_400, when);
    expect(await scene.walletOf(ana)).toMatchObject({ reservedCash: 40_000, openOrders: 2 });
    expect(await scene.positionOf(ana, "FLA3")).toMatchObject({ shares: 1_200, reservedShares: 100 });

    await scene.registerFinal(m, [1, 0]);
    await scene.close(s.seasonId, REGISTERED);

    expect(await scene.orderOf(buyId)).toMatchObject({ status: "cancelled", cancelReason: "trading_end", reservedCash: 0 });
    expect(await scene.orderOf(sellId)).toMatchObject({ status: "cancelled", cancelReason: "trading_end" });
    expect(await scene.walletOf(ana)).toMatchObject({ reservedCash: 0, openOrders: 0 });
    expect(await scene.positionOf(ana, "FLA3")).toMatchObject({ shares: 1_200, reservedShares: 0 });
    // a casa para de cotar: nenhuma ordem aberta na temporada
    const open = await t.db.select().from(orders).where(and(eq(orders.seasonId, s.seasonId), eq(orders.status, "open")));
    expect(open).toEqual([]);
    expect(await scene.place(s, ana, "FLA3", "sell", 1, 4_000, after(REGISTERED, 5))).toMatchObject({ ok: false, code: "market_closed" });

    // a foto inclui as ações que estavam na ordem de venda e não inclui a tesouraria
    const buyback = await scene.buybackOf(s, "FLA3");
    expect(await holdersOf(buyback.id)).toEqual([[ana, 1_200]]);
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("dividendos 17, 18, 23 e 24: recompra de R$ 59,10, R$ 8,33, R$ 7,13, R$ 19,35 e R$ 0,00 por ação, um evento por clube listado", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    await scene.buy(s, ana, "FLA3", 1_000);
    await scene.seasonEnd(s);
    await scene.close(s.seasonId, REGISTERED);

    const events = await scene.buybacksOf(s);
    const perShare = Object.fromEntries(await Promise.all(events.map(async (e) => [LISTED.find((tk) => scene.club(tk) === e.clubId)!, e.perShare] as const)));
    expect(perShare).toEqual(Object.fromEntries(LISTED.map((tk) => [tk, BUYBACKS[tk as keyof typeof BUYBACKS] ?? 0])));
    expect(perShare).toMatchObject({ FLA3: 5_910, PAL3: 833, GRE3: 713, SAO3: 1_935, COR3: 0 });
    for (const e of events) expect(e.eventKey).toBe(`buyback|temporada|fim|${LISTED.find((tk) => scene.club(tk) === e.clubId)}`);
    // clube sem dono (fora a tesouraria) não tem foto; o FLA3 tem a de Ana
    expect(await holdersOf((await scene.buybackOf(s, "COR3")).id)).toEqual([]);
    expect(await holdersOf((await scene.buybackOf(s, "FLA3")).id)).toEqual([[ana, 1_000]]);
  });

  it("rodar a passada de novo não grava outro evento", async () => {
    const s = await scene.newSeason();
    await scene.seasonEnd(s);
    await scene.close(s.seasonId, REGISTERED);
    const first = await scene.buybacksOf(s);
    const changes = rankings.changes.length;

    const again = await scene.close(s.seasonId, after(REGISTERED, 5));
    expect(again).toMatchObject({ created: 0, versioned: 0, superseded: 0, errors: [] });
    expect(await scene.buybacksOf(s)).toEqual(first);
    expect(rankings.changes.length).toBe(changes);
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading_ended", tradingEndedAt: REGISTERED });
  });

  it("a recompra não fecha antes dos 2 minutos de margem da F12", async () => {
    const s = await scene.newSeason();
    await scene.seasonEnd(s);
    await scene.close(s.seasonId, new Date(FINAL_END.getTime() + 119_000));
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading" });
    expect(await scene.buybacksOf(s)).toEqual([]);

    const closedAt = after(FINAL_END, 2);
    await scene.close(s.seasonId, closedAt);
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading_ended", tradingEndedAt: closedAt });
    expect((await scene.buybacksOf(s)).every((e) => e.closedAt.getTime() === closedAt.getTime())).toBe(true);
  });

  it("rankings 23: antes de D o patrimônio não conta a recompra prevista; a partir de D as ações valem R$ 0,00 e conta a recompra a receber", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    await scene.buy(s, ana, "FLA3", 1_200);
    await scene.seasonEnd(s);
    await scene.close(s.seasonId, REGISTERED);
    const cash = await scene.cashOf(ana);
    const fla = scene.club("FLA3");

    const before = (await scene.equityAt(s, new Date(REGISTERED.getTime() - 1))).get(ana)!;
    expect(before.buybackClosed).toBe(false);
    // só o título da final (fechado às 18h) a receber; as ações valem pelo preço
    expect(before.receivableByClub.get(fla)).toBe(1_200 * TITLES.cdb);
    expect(before.equity - before.cash - before.receivable).toBeGreaterThan(0);

    const atD = (await scene.equityAt(s, REGISTERED)).get(ana)!;
    expect(atD.buybackClosed).toBe(true);
    expect(atD.receivableByClub.get(fla)).toBe(1_200 * (TITLES.cdb + BUYBACKS.FLA3));
    expect(atD.cash).toBe(cash);
    expect(atD.equity).toBe(cash + 1_200 * (TITLES.cdb + BUYBACKS.FLA3));
  });

  it("a tesouraria fica de fora da foto e as posições não mudam no fechamento", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    await scene.buy(s, ana, "SAO3", 300);
    await scene.seasonEnd(s);
    await scene.close(s.seasonId, REGISTERED);
    const [treasury] = await t.db.select().from(wallets).where(eq(wallets.id, s.treasury));
    expect(treasury!.ownerType).toBe("treasury");
    const holdings = await t.db
      .select()
      .from(payoutEvents)
      .where(and(eq(payoutEvents.seasonId, s.seasonId), eq(payoutEvents.kind, "buyback")))
      .orderBy(asc(payoutEvents.id));
    for (const e of holdings) expect((await scene.holdingsOf(e.id)).some((h) => h.walletId === s.treasury)).toBe(false);
    const [sao] = await t.db.select().from(positions).where(and(eq(positions.walletId, s.treasury), eq(positions.clubId, scene.club("SAO3"))));
    expect(sao!.shares).toBe(10_000 - 300);
  });
});
