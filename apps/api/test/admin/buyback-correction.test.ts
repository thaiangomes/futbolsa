import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { matches, payoutCredits, payoutEvents } from "../../src/infra/db/schema/index.js";
import { ApplyCorrectionService } from "../../src/modules/admin/payouts/apply-correction.service.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { MatchesService } from "../../src/modules/admin/results/matches.service.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { after, CALLS, prepareCalls, RecordingRankings, type Season, SilentWaker } from "../payouts/correction-scene.js";
import { A_END, at, buybackScene, LIB_END, REGISTERED } from "./buyback-scene.js";

const REASON = "resultado corrigido na súmula oficial";

describe("correção com a recompra fechada (F15, T5)", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(REGISTERED);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  let applier: ApplyCorrectionService;
  let settle: SettleCreditsService;
  const scene = buybackScene(() => t.db, () => app, clock);

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
    await scene.init();
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

  /**
   * A final da Copa do Brasil VAS3 × COR3, 2 × 1 para o VAS3 (título de R$ 8,00, recompra de R$ 12,00); Ana com 500
   * VAS3, Bruno com 300 COR3; às 18h10, depois do apito, Ana vende 200 VAS3 a Bruno; o placar chega às 18h15.
   */
  async function vasFinal() {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    const bruno = await scene.player(s);
    await scene.buy(s, ana, "VAS3", 500);
    await scene.buy(s, bruno, "COR3", 300);
    await scene.seasonEnd(s, { cdb: { home: "VAS3", away: "COR3", score: [2, 1] }, titles: { cdb: 800 } });
    await scene.transfer(ana, bruno, "VAS3", 200, at("2027-12-19T21:10:00Z"));
    expect((await scene.close(s.seasonId, REGISTERED)).errors).toEqual([]);
    expect((await scene.buybackOf(s, "VAS3")).perShare).toBe(1_200);
    expect((await scene.buybackOf(s, "COR3")).perShare).toBe(0);
    return { s, ana, bruno };
  }

  const keyOf = (kind: string, ticker: string) => (kind === "buyback" ? `buyback|temporada|fim|${ticker}` : `${kind}|copa-do-brasil|final|${ticker}`);

  it("dividendos 25 e admin 17: título do VAS3 corrigido para o COR3 depois da recompra paga tira R$ 12,00 por ação de quem tinha VAS3 em D e dá R$ 12,00 a quem tinha COR3", async () => {
    const { s, ana, bruno } = await vasFinal();
    await scene.approveAll(after(REGISTERED, 30));
    const cash = { ana: await scene.cashOf(ana), bruno: await scene.cashOf(bruno) };
    expect(await scene.sharesOf(ana, "VAS3")).toBe(0);
    expect(await scene.sharesOf(bruno, "COR3")).toBe(0);

    // a final era do COR3
    await scene.setScore(s.seasonId, "VAS3", [1, 2]);
    const plan = await scene.plan(s.seasonId, after(REGISTERED, 60));
    const changes = Object.fromEntries(plan.preview.changes.map((c) => [c.key, [c.outcome, c.before, c.after, c.total]]));
    expect(changes).toEqual({
      [keyOf("cup_title", "VAS3")]: ["vanished", 800, 0, -500 * 800],
      [keyOf("cup_title", "COR3")]: ["new_in_paid_group", 0, 800, 300 * 800],
      // a recompra pela foto de D: Ana com 300 VAS3, Bruno com 200 VAS3 (comprados depois do apito) e 300 COR3
      [keyOf("buyback", "VAS3")]: ["correction", 1_200, 0, -500 * 1_200],
      [keyOf("buyback", "COR3")]: ["correction", 0, 1_200, 300 * 1_200],
    });
    expect(plan.preview.changes.find((c) => c.kind === "buyback")!.competition).toBeNull();

    clock.set(after(REGISTERED, 60));
    await applier.apply(scene.admin.id, { planCode: plan.planCode, reason: REASON });
    expect((await settle.settlePending()).errors).toEqual([]);

    expect(await scene.cashOf(ana)).toBe(cash.ana - 500 * 800 - 300 * 1_200);
    expect(await scene.cashOf(bruno)).toBe(cash.bruno + 300 * 800 - 200 * 1_200 + 300 * 1_200);
    // a recompra corrigida é só dinheiro: as ações já tinham saído
    const vas = await scene.buybackOf(s, "VAS3");
    const cor = await scene.buybackOf(s, "COR3");
    expect(vas).toMatchObject({ version: 2, status: "approved", perShare: 0, closedAt: REGISTERED, competition: null });
    expect(cor).toMatchObject({ version: 2, status: "approved", perShare: 1_200, closedAt: REGISTERED });
    expect((await scene.holdingsOf(vas.id)).map((h) => [h.walletId, h.shares])).toEqual([
      [ana, 300],
      [bruno, 200],
    ]);
    const anaLines = (await scene.entriesOf(ana, ["reversal", "complement", "buyback"])).map((e) => [e.kind, e.cashDelta, e.sharesDelta]);
    expect(anaLines[0]).toEqual(["buyback", 300 * 1_200, -300]);
    expect(anaLines.slice(1).sort()).toEqual(
      [
        ["reversal", -500 * 800, 0],
        ["reversal", -300 * 1_200, 0],
      ].sort(),
    );
    const brunoLines = (await scene.entriesOf(bruno, ["reversal", "complement"])).map((e) => [e.kind, e.cashDelta, e.sharesDelta]);
    expect(brunoLines.sort()).toEqual(
      [
        ["complement", 300 * 800, 0],
        ["complement", 300 * 1_200, 0],
        ["reversal", -200 * 1_200, 0],
      ].sort(),
    );
    expect(await scene.sharesOf(ana, "VAS3")).toBe(0);
    expect(await scene.sharesOf(bruno, "VAS3")).toBe(0);
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("correção antes da aprovação só refaz a prévia da recompra, com a foto de D copiada", async () => {
    const { s, ana, bruno } = await vasFinal();
    const v1 = { vas: await scene.buybackOf(s, "VAS3"), cor: await scene.buybackOf(s, "COR3") };
    const cash = { ana: await scene.cashOf(ana), bruno: await scene.cashOf(bruno) };

    await scene.setScore(s.seasonId, "VAS3", [1, 2]);
    expect((await scene.close(s.seasonId, after(REGISTERED, 10))).errors).toEqual([]);

    const vas = await scene.buybackOf(s, "VAS3");
    const cor = await scene.buybackOf(s, "COR3");
    expect(vas).toMatchObject({ version: 2, status: "pending", perShare: 0, closedAt: REGISTERED, supersedesId: v1.vas.id });
    expect(cor).toMatchObject({ version: 2, status: "pending", perShare: 1_200, closedAt: REGISTERED, supersedesId: v1.cor.id });
    expect(await scene.holdingsOf(vas.id)).toEqual(await scene.holdingsOf(v1.vas.id));
    expect(await scene.holdingsOf(cor.id)).toEqual(await scene.holdingsOf(v1.cor.id));
    const [old] = await t.db.select().from(payoutEvents).where(eq(payoutEvents.id, v1.vas.id));
    expect(old!.status).toBe("superseded");
    // nada caiu no caixa nem saiu das carteiras
    const credits = await t.db
      .select()
      .from(payoutCredits)
      .innerJoin(payoutEvents, eq(payoutEvents.id, payoutCredits.eventId))
      .where(eq(payoutEvents.seasonId, s.seasonId));
    expect(credits).toEqual([]);
    expect(await scene.cashOf(ana)).toBe(cash.ana);
    expect(await scene.cashOf(bruno)).toBe(cash.bruno);
    expect(await scene.sharesOf(ana, "VAS3")).toBe(300);
    // e a aprovação da versão nova paga o COR3, tira as ações e não paga o VAS3
    await scene.approveAll(after(REGISTERED, 30));
    expect(await scene.cashOf(bruno)).toBe(cash.bruno + 300 * 800 + 300 * 1_200);
    expect(await scene.sharesOf(ana, "VAS3")).toBe(0);
    expect(await scene.sharesOf(bruno, "VAS3")).toBe(0);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("estorno maior que o caixa deixa o caixa negativo (as compras já foram canceladas no fim da negociação)", async () => {
    const s: Season = await scene.newSeason();
    // Ana gasta tudo: R$ 1.000,00 em 1.000 PAL3
    const ana = await scene.player(s, 1_000 * 100);
    await scene.buy(s, ana, "PAL3", 1_000);
    await scene.seasonEnd(s, { titles: { lib: 1_200, cdb: 0 } });
    // a final da Libertadores (PAL3 campeão, R$ 12,00) é paga durante a negociação, e Ana gasta o título em FLA3
    expect((await scene.close(s.seasonId, after(LIB_END, 5))).errors).toEqual([]);
    await scene.approveAll(after(LIB_END, 10));
    expect(await scene.cashOf(ana)).toBe(1_000 * 1_200);
    await scene.buyAt(s, ana, "FLA3", 1_000, 1_200, after(LIB_END, 20));
    expect(await scene.cashOf(ana)).toBe(0);

    // a recompra fecha e é paga: PAL3 a R$ 18,00, FLA3 a R$ 0,00
    expect((await scene.close(s.seasonId, REGISTERED)).errors).toEqual([]);
    await scene.approveAll(after(REGISTERED, 30));
    expect(await scene.cashOf(ana)).toBe(1_000 * 1_800);

    // a final da Libertadores era do clube de fora: estorno do título e da recompra do PAL3
    await scene.setScore(s.seasonId, "PAL3", [0, 2]);
    const plan = await scene.plan(s.seasonId, after(REGISTERED, 60));
    expect(plan.preview.wallets).toMatchObject({ pay: 1, negative: 1, buysCancelled: 0 });
    clock.set(after(REGISTERED, 60));
    await applier.apply(scene.admin.id, { planCode: plan.planCode, reason: REASON });
    expect((await settle.settlePending()).errors).toEqual([]);
    expect(await scene.walletOf(ana)).toMatchObject({ cash: 1_000 * 1_800 - 1_000 * 1_200 - 1_000 * 1_800, reservedCash: 0 });
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("admin 37: com a recompra fechada, cadastrar jogo ou voltar um jogo para agendado é recusado com season_trading_ended, e corrigir o placar de um jogo disputado passa", async () => {
    const s = await scene.newSeason();
    const m = await scene.seasonEnd(s);
    await scene.close(s.seasonId, REGISTERED);
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading_ended" });
    const matchesService = scene.service(MatchesService);
    const actor = scene.admin.id;

    const created = await scene.domainError(
      matchesService.create(actor, {
        competition: "brasileirao-a",
        round: 2,
        homeClubId: scene.club("FLA3"),
        awayClubId: scene.club("PAL3"),
        kickoff: "2027-12-26T19:00:00.000Z",
        status: "scheduled",
        reason: REASON,
      }),
    );
    expect(created).toMatchObject({ code: "season_trading_ended", status: 409 });

    // voltar a final para agendado, adiar ou cancelar um jogo disputado reabriria a competição
    for (const body of [
      { status: "scheduled" as const, homeGoals: null, awayGoals: null, finishedAt: null, reason: REASON },
      { status: "postponed" as const, homeGoals: null, awayGoals: null, reason: REASON },
      { status: "cancelled" as const, homeGoals: null, awayGoals: null, reason: REASON },
    ]) {
      expect(await scene.domainError(matchesService.patch(actor, m.cdb, body))).toMatchObject({ code: "season_trading_ended" });
    }
    const [final] = await t.db.select().from(matches).where(eq(matches.id, m.cdb));
    expect(final).toMatchObject({ status: "finished", homeGoals: 1, awayGoals: 0 });

    // corrigir o placar de um jogo disputado continua aceito
    const fixed = await matchesService.patch(actor, m.a, { homeGoals: 2, awayGoals: 1, reason: REASON });
    expect(fixed).toMatchObject({ status: "finished", homeGoals: 2, awayGoals: 1 });
    const [league] = await t.db.select().from(matches).where(and(eq(matches.id, m.a), eq(matches.seasonId, s.seasonId)));
    expect(league!.finishedAt).toEqual(A_END);
    // e a temporada continua com a negociação encerrada no mesmo instante
    expect(await scene.seasonOf(s)).toMatchObject({ status: "trading_ended", tradingEndedAt: REGISTERED });
  });
});
