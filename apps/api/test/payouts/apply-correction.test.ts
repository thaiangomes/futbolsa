import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCorrectionResponseSchema, correctionPreviewSchema, correctionStaleResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { adminLog, marketRefreshRequests, matches, payoutCredits, users, wallets } from "../../src/infra/db/schema/index.js";
import { ApplyCorrectionService } from "../../src/modules/admin/payouts/apply-correction.service.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService, SETTLE_BATCH } from "../../src/modules/admin/payouts/settle-credits.js";
import { dues, duesQuery, settlingEventIds } from "../../src/modules/admin/payouts/settlement.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import {
  after,
  at,
  CALLS,
  correctionScene,
  FlakyLedger,
  MIN,
  prepareCalls,
  PRICE,
  RecordingRankings,
  RICH,
  ROUND10_CLOSE,
  type Season,
  SilentWaker,
} from "./correction-scene.js";

const REASON = "placar do CAM3 × BOT3 corrigido na súmula";

describe("correção aplicada (POST /admin/payouts/corrections)", () => {
  const t = useTestDatabase(12);
  const clock = new FixedClock(ROUND10_CLOSE);
  const rankings = new RecordingRankings();
  const ledger = new FlakyLedger();
  let app: NestFastifyApplication;
  let applier: ApplyCorrectionService;
  let settle: SettleCreditsService;
  const scene = correctionScene(() => t.db, () => app, clock);

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(PortfolioLedger).useValue(ledger).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
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
    settle.batchSize = SETTLE_BATCH;
    ledger.failFrom = null;
    ledger.posts = 0;
    rankings.reset();
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  const apply = (planCode: string, now: Date, reason = REASON) => {
    clock.set(now);
    return applier.apply(scene.admin.id, { planCode, reason });
  };
  /** Aplica e espera a liquidação de todos os eventos (a tarefa de cada minuto). */
  const applyAndSettle = async (planCode: string, now: Date, reason = REASON) => {
    const result = await apply(planCode, now, reason);
    const summary = await settle.settlePending();
    expect(summary.errors).toEqual([]);
    return result;
  };

  /**
   * O cenário dos critérios 12 e 13: a rodada 10 paga (CAM3 2 × 1 BOT3, R$ 0,30 por ação do CAM3), Bruno com 2.000 CAM3
   * e R$ 150,00 no caixa na hora da correção (gastou o dividendo), Carla com 1.000 BOT3; o placar vira 1 × 1.
   */
  async function round10Paid(): Promise<{ s: Season; bruno: number; carla: number; now: Date }> {
    const s = await scene.newSeason();
    const bruno = await scene.player(s, 15_000 + 2_000 * PRICE);
    await scene.buy(s, bruno, "CAM3", 2_000);
    const carla = await scene.player(s);
    await scene.buy(s, carla, "BOT3", 1_000);
    await scene.insertMatches(scene.round10(s.seasonId));
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await scene.approveAll(after(ROUND10_CLOSE, 5));
    expect(await scene.cashOf(bruno)).toBe(15_000 + 60_000);
    await scene.buy(s, bruno, "FLA3", 600, after(ROUND10_CLOSE, 30));
    expect(await scene.cashOf(bruno)).toBe(15_000);
    await scene.setScore(s.seasonId, "CAM3", [1, 1]);
    // o que a montagem avisou aos rankings não conta
    rankings.reset();
    await t.db.execute(sql`delete from ${CALLS}`);
    return { s, bruno, carla, now: after(ROUND10_CLOSE, 60) };
  }

  it("admin 12: Bruno fica com −R$ 250,00 e o extrato mostra o estorno com o motivo", async () => {
    const { s, bruno, now } = await round10Paid();
    const p = await scene.plan(s.seasonId, now);
    const [camV1] = await scene.eventsOf(s.seasonId, "CAM3");

    const result = await applyAndSettle(p.planCode, now);

    expect(await scene.cashOf(bruno)).toBe(-25_000);
    const [reversal] = await scene.entriesOf(bruno, ["reversal"]);
    const camEvents = await scene.eventsOf(s.seasonId, "CAM3");
    expect(camEvents).toHaveLength(2);
    const [old, v2] = camEvents as [NonNullable<typeof camV1>, NonNullable<typeof camV1>];
    expect(old).toMatchObject({ id: camV1!.id, status: "superseded", version: 1, perShare: 30 });
    expect(v2).toMatchObject({
      status: "approved",
      version: 2,
      supersedesId: camV1!.id,
      perShare: 10,
      closedAt: ROUND10_CLOSE,
      approvedBy: scene.admin.id,
      approvedAt: now,
      eventKey: "points|brasileirao-a|10|CAM3",
    });
    // a foto da versão nova é a da antiga (o fechamento não mudou)
    expect(await scene.holdingsOf(v2.id)).toEqual(await scene.holdingsOf(camV1!.id));
    expect(reversal).toMatchObject({ kind: "reversal", cashDelta: -40_000, cashAfter: -25_000, clubId: scene.club("CAM3"), refType: "payout_event", refId: String(v2.id), at: now });
    expect(reversal!.reason).toContain(REASON);
    expect(reversal!.reason).toContain(v2.reason);
    // a linha do crédito da versão nova é o líquido da carteira
    expect((await scene.creditsOf(v2.id)).map((c) => [c.walletId, c.amount, c.entryId])).toEqual([[bruno, -40_000, reversal!.id]]);
    // o que já foi pago pela chave é a soma das versões: ações × valor vigente
    expect((await scene.paidByKey(s.seasonId, "CAM3")).get(bruno)).toBe(2_000 * 10);
    // a resposta diz o que foi gravado
    expect(applyCorrectionResponseSchema.parse(result)).toEqual(result);
    expect(result.events.find((e) => e.ticker === "CAM3")).toEqual({ eventId: v2.id, key: v2.eventKey, ticker: "CAM3", version: 2, supersedesId: camV1!.id, perShare: 10 });
    expect(result.wallets).toEqual(p.preview.wallets);
    // depois de liquidada, nada mais a corrigir, e a prévia dos pagamentos mostra a versão nova liquidada
    expect((await scene.plan(s.seasonId, after(now, 1))).preview.changes).toEqual([]);
    clock.set(after(now, 2));
    const list = await app.inject({ method: "GET", url: "/admin/payouts", headers: { authorization: `Bearer ${await scene.admin.tokenWith({ at: after(now, 2) })}` } });
    expect(list.statusCode).toBe(200);
    const listed = (list.json() as { events: Array<{ id: number; settlement: unknown }> }).events.find((e) => e.id === v2.id);
    expect(listed?.settlement).toEqual({ state: "settled", credited: 1, expected: 1 });
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("admin 13: Carla recebe R$ 100,00 quando a correção é aplicada, sem nova aprovação", async () => {
    const { s, carla, now } = await round10Paid();
    const before = await scene.cashOf(carla);
    expect(await scene.eventsOf(s.seasonId, "BOT3")).toEqual([]);
    const p = await scene.plan(s.seasonId, now);
    await applyAndSettle(p.planCode, now);

    const [bot3] = await scene.eventsOf(s.seasonId, "BOT3");
    expect(bot3).toMatchObject({ status: "approved", version: 1, supersedesId: null, perShare: 10, closedAt: ROUND10_CLOSE, approvedBy: scene.admin.id });
    expect(await scene.holdingsOf(bot3!.id)).toEqual([{ walletId: carla, shares: 1_000 }]);
    expect(await scene.cashOf(carla)).toBe(before + 10_000);
    const [complement] = await scene.entriesOf(carla, ["complement"]);
    expect(complement).toMatchObject({ kind: "complement", cashDelta: 10_000, clubId: scene.club("BOT3"), refId: String(bot3!.id) });
    expect(complement!.reason).toContain(REASON);
    expect((await scene.creditsOf(bot3!.id)).map((c) => [c.walletId, c.amount])).toEqual([[carla, 10_000]]);
  });

  it("admin 33: a correção vai para o registro com o motivo; aviso aos rankings na transação e reposição do formador", async () => {
    const { s, now } = await round10Paid();
    const p = await scene.plan(s.seasonId, now);
    const result = await apply(p.planCode, now);

    const [log] = await t.db.select().from(adminLog).where(and(eq(adminLog.action, "payout.correct"), eq(adminLog.targetId, p.planCode)));
    expect(log).toMatchObject({ actorId: scene.admin.id, at: now, targetType: "payout_correction", reason: REASON });
    expect((log!.after as { eventIds: number[] }).eventIds.sort()).toEqual(result.events.map((e) => e.eventId).sort());
    expect(log!.after).toMatchObject({ wallets: p.preview.wallets });
    expect(log!.before).toMatchObject({ events: [expect.objectContaining({ key: "points|brasileirao-a|10|CAM3", version: 1, perShare: 30 })] });

    // o aviso dos fechamentos antigos e novos, dentro da transação; wake() só depois do COMMIT
    expect(rankings.changes).toEqual([{ seasonId: s.seasonId, closedAts: [ROUND10_CLOSE] }]);
    expect(rankings.wakes).toEqual([{ recorded: 1, visible: 1 }]);
    // a casa repõe a cotação dos clubes afetados
    const refresh = await t.db.select().from(marketRefreshRequests).where(and(eq(marketRefreshRequests.seasonId, s.seasonId), eq(marketRefreshRequests.reason, "correction")));
    expect(refresh.map((r) => r.clubId).sort()).toEqual([scene.club("BOT3"), scene.club("CAM3")].sort());

    // os lotes de crédito não avisam de novo
    await settle.settlePending();
    expect(rankings.changes).toHaveLength(1);
    expect(rankings.wakes).toHaveLength(1);
  });

  it("admin 17: o título passa do VAS3 para o COR3: quem tinha VAS3 devolve e quem tinha COR3 recebe", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    const bruno = await scene.player(s);
    await scene.buy(s, ana, "VAS3", 1_000);
    await scene.buy(s, bruno, "COR3", 500);
    const kickoff = at("2027-12-19T21:30:00-03:00");
    const [final] = await scene.insertMatches([
      {
        seasonId: s.seasonId,
        competition: "copa-do-brasil",
        phase: "final",
        homeClubId: scene.club("VAS3"),
        awayClubId: scene.club("COR3"),
        kickoff,
        finishedAt: new Date(kickoff.getTime() + 120 * MIN),
        homeGoals: 1,
        awayGoals: 1,
        status: "finished",
        advancedClubId: scene.club("VAS3"),
      },
    ]);
    const now = at("2027-12-20T12:00:00Z");
    await scene.close(s.seasonId, now);
    await scene.approveAll(after(now, 1));
    const [anaPaid, brunoBefore] = [await scene.cashOf(ana), await scene.cashOf(bruno)];

    await t.db.update(matches).set({ advancedClubId: scene.club("COR3") }).where(eq(matches.id, final!.id));
    const p = await scene.plan(s.seasonId, after(now, 60));
    await applyAndSettle(p.planCode, after(now, 60));

    const [vasOld, vasNew] = await scene.eventsOf(s.seasonId, "VAS3");
    expect(vasOld).toMatchObject({ kind: "cup_title", status: "superseded", perShare: 800 });
    expect(vasNew).toMatchObject({ kind: "cup_title", status: "approved", perShare: 0, version: 2, supersedesId: vasOld!.id });
    const [cor] = await scene.currentOf(s.seasonId, "COR3");
    expect(cor).toMatchObject({ kind: "cup_title", status: "approved", perShare: 800, version: 1 });
    expect(await scene.cashOf(ana)).toBe(anaPaid - 800_000);
    expect(await scene.cashOf(bruno)).toBe(brunoBefore + 400_000);
    expect((await scene.paidByKey(s.seasonId, "VAS3")).get(ana)).toBe(0);
    expect((await scene.paidByKey(s.seasonId, "COR3")).get(bruno)).toBe(400_000);
  });

  it("código de plano velho dá correction_stale com a prévia nova, e nada é gravado", async () => {
    const { s, bruno, now } = await round10Paid();
    const p = await scene.plan(s.seasonId, now);
    // alguém muda outro resultado depois da prévia
    await scene.setScore(s.seasonId, "FLA3", [0, 0]);
    const fresh = await scene.plan(s.seasonId, after(now, 1));
    expect(fresh.planCode).not.toBe(p.planCode);

    const error = await scene.domainError(apply(p.planCode, after(now, 1)));
    expect(error.code).toBe("correction_stale");
    expect(error.status).toBe(409);
    const res = await scene.route({ planCode: p.planCode, reason: REASON }, after(now, 2));
    expect(res.statusCode).toBe(409);
    const body = correctionStaleResponseSchema.parse(res.json());
    expect(body.code).toBe("correction_stale");
    expect(body.preview).toEqual(fresh.preview);

    expect(await scene.eventsOf(s.seasonId, "CAM3")).toEqual([expect.objectContaining({ status: "approved", version: 1 })]);
    expect(await scene.cashOf(bruno)).toBe(15_000);
    expect(rankings.changes).toEqual([]);
    expect(await t.db.select().from(adminLog).where(eq(adminLog.action, "payout.correct")).then((r) => r.filter((x) => x.targetId === p.planCode))).toEqual([]);
  });

  it("dois admins aplicando o mesmo plano: um aplica, o outro recebe correction_stale", async () => {
    const { s, bruno, carla, now } = await round10Paid();
    const p = await scene.plan(s.seasonId, now);
    const carlaBefore = await scene.cashOf(carla);
    clock.set(now);
    const outcomes = await Promise.allSettled([
      applier.apply(scene.admin.id, { planCode: p.planCode, reason: REASON }),
      applier.apply(scene.admin.id, { planCode: p.planCode, reason: `${REASON} (de novo)` }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const [rejected] = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(rejected!.reason).toMatchObject({ code: "correction_stale", status: 409 });

    await settle.settlePending();
    expect(await scene.cashOf(bruno)).toBe(-25_000);
    expect(await scene.cashOf(carla)).toBe(carlaBefore + 10_000);
    expect(await scene.eventsOf(s.seasonId, "CAM3")).toHaveLength(2);
    expect(await scene.eventsOf(s.seasonId, "BOT3")).toHaveLength(1);
  });

  it("segunda correção sobre a primeira dá o valor líquido certo (a versão 3 corrige a 2)", async () => {
    const { s, bruno, carla, now } = await round10Paid();
    const carlaBefore = await scene.cashOf(carla);
    await applyAndSettle((await scene.plan(s.seasonId, now)).planCode, now);
    expect(await scene.cashOf(bruno)).toBe(-25_000);

    // o placar volta a 2 × 1: o CAM3 volta a R$ 0,30 e o BOT3 some (R$ 0,00)
    await scene.setScore(s.seasonId, "CAM3", [2, 1]);
    const second = await scene.plan(s.seasonId, after(now, 30));
    expect(second.preview.changes.map((c) => [c.club.ticker, c.before, c.after, c.outcome])).toEqual([
      ["BOT3", 10, 0, "vanished"],
      ["CAM3", 10, 30, "correction"],
    ]);
    await applyAndSettle(second.planCode, after(now, 30), "a súmula estava certa");

    const cam = await scene.eventsOf(s.seasonId, "CAM3");
    expect(cam.map((e) => [e.version, e.status, e.perShare])).toEqual([
      [1, "superseded", 30],
      [2, "superseded", 10],
      [3, "approved", 30],
    ]);
    expect(cam[2]!.supersedesId).toBe(cam[1]!.id);
    expect(await scene.cashOf(bruno)).toBe(-25_000 + 40_000);
    expect(await scene.cashOf(carla)).toBe(carlaBefore);
    expect((await scene.paidByKey(s.seasonId, "CAM3")).get(bruno)).toBe(60_000);
    expect((await scene.paidByKey(s.seasonId, "BOT3")).get(carla)).toBe(0);
    const [complement] = await scene.entriesOf(bruno, ["complement"]);
    expect(complement).toMatchObject({ cashDelta: 40_000, refId: String(cam[2]!.id) });
    expect(complement!.reason).toContain("a súmula estava certa");
    await assertLedgerConsistent(t.db, s.seasonId);
  });

  it("correção sem motivo é recusada (400) e nada é gravado", async () => {
    const { s, now } = await round10Paid();
    const p = await scene.plan(s.seasonId, now);
    const noReason = await scene.route({ planCode: p.planCode }, now);
    expect(noReason.statusCode).toBe(400);
    const blank = await scene.route({ planCode: p.planCode, reason: "   " }, now);
    expect(blank.statusCode).toBe(400);
    // pelo serviço, a mesma recusa do registro do admin
    const error = await scene.domainError(apply(p.planCode, now, "  "));
    expect(error.code).toBe("reason_required");
    expect(await scene.eventsOf(s.seasonId, "CAM3")).toEqual([expect.objectContaining({ status: "approved", version: 1 })]);
    expect(rankings.changes).toEqual([]);
  });

  it("pela rota: 200 com o que foi aplicado, e a liquidação segue em segundo plano", async () => {
    const { s, bruno, now } = await round10Paid();
    const p = await scene.plan(s.seasonId, now);
    const res = await scene.route({ planCode: p.planCode, reason: REASON }, now);
    expect(res.statusCode).toBe(200);
    const body = applyCorrectionResponseSchema.parse(res.json());
    expect(body.planCode).toBe(p.planCode);
    expect(body.events.map((e) => e.ticker).sort()).toEqual(["BOT3", "CAM3"]);
    await settle.whenIdle();
    expect(await scene.cashOf(bruno)).toBe(-25_000);
  });

  it("interrompida no meio, a tarefa termina sem estorno repetido", async () => {
    const s = await scene.newSeason();
    const holders: number[] = [];
    for (let i = 0; i < 5; i++) {
      const w = await scene.player(s);
      await scene.buy(s, w, "CAM3", 100 * (i + 1));
      holders.push(w);
    }
    const carla = await scene.player(s);
    await scene.buy(s, carla, "BOT3", 1_000);
    await scene.insertMatches(scene.round10(s.seasonId));
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await scene.approveAll(after(ROUND10_CLOSE, 5));
    const before = await Promise.all([...holders, carla].map(scene.cashOf));
    await scene.setScore(s.seasonId, "CAM3", [1, 1]);
    const now = after(ROUND10_CLOSE, 60);
    const p = await scene.plan(s.seasonId, now);
    await apply(p.planCode, now);

    // lotes de 2 carteiras; a API "cai" no 4º lançamento (o 2º lote do CAM3 desfaz inteiro)
    settle.batchSize = 2;
    ledger.posts = 0;
    ledger.failFrom = 4;
    const first = await settle.settlePending();
    expect(first.errors.length).toBeGreaterThan(0);
    const [, camV2] = await scene.eventsOf(s.seasonId, "CAM3");
    expect((await scene.creditsOf(camV2!.id)).length).toBeLessThan(5);
    expect(await settlingEventIds(t.db, s.seasonId)).toContain(camV2!.id);

    ledger.failFrom = null;
    const second = await settle.settlePending();
    expect(second.errors).toEqual([]);
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([]);
    expect((await scene.creditsOf(camV2!.id)).map((c) => c.amount)).toEqual(holders.map((_, i) => -20 * 100 * (i + 1)));
    for (const w of holders) expect(await scene.entriesOf(w, ["reversal"])).toHaveLength(1);
    const afterCash = await Promise.all([...holders, carla].map(scene.cashOf));
    expect(afterCash).toEqual([...holders.map((_, i) => before[i]! - 20 * 100 * (i + 1)), before[5]! + 10_000]);
    // rodar de novo não acha mais nada
    expect((await settle.settlePending()).credited).toBe(0);
    await assertLedgerConsistent(t.db, s.seasonId);
  });

  it("carteira com líquido zero não precisa de crédito: o evento não fica liquidando para sempre", async () => {
    const s = await scene.newSeason();
    const bruno = await scene.player(s);
    const dani = await scene.player(s);
    await scene.buy(s, bruno, "CAM3", 2_000);
    await scene.insertMatches(scene.round10(s.seasonId));
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await scene.approveAll(after(ROUND10_CLOSE, 5));
    // o último jogo acabou às 20h30, não às 20h: o fechamento muda, o valor não; Bruno tem as mesmas ações nos dois
    // instantes (líquido zero), e Dani compra 300 da tesouraria às 20h10 (recebe pela foto nova)
    await scene.buy(s, dani, "CAM3", 300, after(ROUND10_CLOSE, 10));
    const late = after(ROUND10_CLOSE, 30);
    await t.db.update(matches).set({ finishedAt: late }).where(eq(matches.id, (await scene.matchOf(s.seasonId, "JUV3")).id));
    const now = after(ROUND10_CLOSE, 60);
    const p = await scene.plan(s.seasonId, now);
    expect(p.wallets.find((w) => w.walletId === bruno)?.amount ?? 0).toBe(0);
    expect(p.wallets.find((w) => w.walletId === dani)?.amount).toBe(9_000);
    await applyAndSettle(p.planCode, now);

    const [, camV2] = await scene.eventsOf(s.seasonId, "CAM3");
    expect(camV2).toMatchObject({ status: "approved", closedAt: late });
    expect((await scene.creditsOf(camV2!.id)).map((c) => [c.walletId, c.amount])).toEqual([[dani, 9_000]]);
    expect(await scene.entriesOf(bruno, ["reversal", "complement"])).toEqual([]);
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([]);
    // a próxima correção não é recusada por "liquidando"
    await scene.setScore(s.seasonId, "CAM3", [1, 1]);
    expect((await scene.plan(s.seasonId, after(now, 5))).preview.changes.length).toBeGreaterThan(0);
  });

  it("revisão T10: dues em conjuntos — quem vendeu tudo entre os fechamentos devolve, e o filtro de carteiras vale para a foto e o já pago", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    const bob = await scene.player(s);
    await scene.buy(s, ana, "CAM3", 500);
    await scene.buy(s, bob, "CAM3", 200);
    await scene.insertMatches(scene.round10(s.seasonId));
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await scene.approveAll(after(ROUND10_CLOSE, 5));
    // Ana passa tudo a Bob às 20h10; o último jogo acabou às 20h30: a foto nova não tem Ana
    await scene.transfer(ana, bob, "CAM3", 500, after(ROUND10_CLOSE, 10));
    await t.db.update(matches).set({ finishedAt: after(ROUND10_CLOSE, 30) }).where(eq(matches.id, (await scene.matchOf(s.seasonId, "JUV3")).id));
    const now = after(ROUND10_CLOSE, 60);
    await apply((await scene.plan(s.seasonId, now)).planCode, now);
    const [, camV2] = await scene.eventsOf(s.seasonId, "CAM3");

    const byWallet = (walletIds: number[]) => dues(t.db, { eventId: camV2!.id, walletIds }).then((r) => r.map((d) => [d.walletId, d.shares, d.amount]));
    expect(await byWallet([ana])).toEqual([[ana, 0, -15_000]]);
    expect(await byWallet([bob])).toEqual([[bob, 700, 15_000]]);
    const [low, high] = [ana, bob].sort((a, b) => a - b);
    const cursor = await dues(t.db, { eventId: camV2!.id, afterWallet: low });
    expect(cursor.map((d) => d.walletId)).toEqual([high]);
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([camV2!.id]);

    // nenhuma subconsulta por carteira: com elas, a temporada inteira levava ~18 s com 200 eventos de 2.000 donos
    const { rows } = await t.db.execute(sql`explain ${duesQuery({ seasonId: s.seasonId })}`);
    expect(rows.map((r) => String(Object.values(r)[0])).join("\n")).not.toContain("SubPlan");

    await settle.settlePending();
    expect((await scene.creditsOf(camV2!.id)).map((c) => [c.walletId, c.amount]).sort((a, b) => a[0]! - b[0]!)).toEqual(
      [[ana, -15_000], [bob, 15_000]].sort((a, b) => a[0]! - b[0]!),
    );
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([]);
    await assertLedgerConsistent(t.db, s.seasonId);
  });

  it("revisão T10: o lote de crédito tem 50 carteiras (a 200 cada lote segurava as carteiras ~1,3 s)", () => {
    expect(SETTLE_BATCH).toBe(50);
  });

  it("regra liquidando: carteira creditada cuja conta foi excluída depois não esconde o crédito que falta", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    const bob = await scene.player(s);
    await scene.buy(s, ana, "CAM3", 100);
    await scene.buy(s, bob, "CAM3", 100);
    await scene.insertMatches(scene.round10(s.seasonId));
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    const [cam] = await scene.eventsOf(s.seasonId, "CAM3");
    // aprovado e só Ana creditada (a liquidação parou), e depois a conta de Ana é excluída
    await t.db.execute(sql`update futbolsa.payout_events set status = 'approved', approved_at = ${after(ROUND10_CLOSE, 5).toISOString()}::timestamptz where id = ${cam!.id}`);
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [ana]);
      const { entry } = await post(tx, { walletId: ana, at: after(ROUND10_CLOSE, 5), kind: "dividend", clubId: scene.club("CAM3"), cashDelta: 3_000, ref: { type: "payout_event", id: cam!.id }, reason: cam!.reason });
      await tx.db.insert(payoutCredits).values({ eventId: cam!.id, walletId: ana, amount: 3_000, entryId: entry.id });
    });
    const [anaWallet] = await t.db.select({ userId: wallets.userId }).from(wallets).where(eq(wallets.id, ana));
    await t.db.update(users).set({ status: "deleted", email: null, nickname: null, deletedAt: after(ROUND10_CLOSE, 6) }).where(eq(users.id, anaWallet!.userId!));

    // um crédito (Ana) e uma carteira que recebe (Bob): a contagem antiga diria "liquidado"; Bob ainda não recebeu
    expect(await settlingEventIds(t.db, s.seasonId)).toContain(cam!.id);
    await settle.settlePending();
    expect(await settlingEventIds(t.db, s.seasonId)).not.toContain(cam!.id);
    expect((await scene.creditsOf(cam!.id)).map((c) => c.walletId)).toEqual([ana, bob].sort((a, b) => a - b));
  });

  it("P6: a conta excluída não recebe nem devolve na correção", async () => {
    const s = await scene.newSeason();
    const gone = await scene.player(s, RICH, "deleted");
    const ana = await scene.player(s);
    await scene.buy(s, gone, "CAM3", 300);
    await scene.buy(s, ana, "CAM3", 200);
    await scene.insertMatches(scene.round10(s.seasonId));
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await scene.approveAll(after(ROUND10_CLOSE, 5));
    const goneCash = await scene.cashOf(gone);
    await scene.setScore(s.seasonId, "CAM3", [1, 1]);
    const now = after(ROUND10_CLOSE, 60);
    await applyAndSettle((await scene.plan(s.seasonId, now)).planCode, now);
    const [, camV2] = await scene.eventsOf(s.seasonId, "CAM3");
    expect((await scene.creditsOf(camV2!.id)).map((c) => [c.walletId, c.amount])).toEqual([[ana, -4_000]]);
    expect(await scene.cashOf(gone)).toBe(goneCash);
    expect(await settlingEventIds(t.db, s.seasonId)).toEqual([]);
  });

  it("admin 31: jogador comum não aplica a correção", async () => {
    const { s, now } = await round10Paid();
    const p = await scene.plan(s.seasonId, now);
    clock.set(new Date(TOKEN_T0.getTime() + 60_000));
    await expectAdminOnly(app, t.db, { method: "POST", url: "/admin/payouts/corrections", payload: { planCode: "x".repeat(64), reason: REASON } }, { okStatus: 409 });
    // nada aplicado
    expect(await scene.eventsOf(s.seasonId, "CAM3")).toHaveLength(1);
    expect(correctionPreviewSchema.parse(p.preview).planCode).toBe(p.planCode);
  });
});
