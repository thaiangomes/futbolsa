import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasonQualifications, standings } from "../../src/infra/db/schema/index.js";
import { ApproveService } from "../../src/modules/admin/payouts/approve.service.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { after, correctionScene, LISTED, PRICE, prepareCalls, RecordingRankings, ROUND10_CLOSE, SilentWaker, UNLISTED } from "./correction-scene.js";

/**
 * Classificação para o ano seguinte e rebaixamento no fechamento da Série A (decisão de 2026-11-20): a tabela oficial vale
 * para a colocação, para o bônus dos classificados que o admin marcou e para o débito de R$ 1,00 por ação dos rebaixados.
 * O débito sai do caixa como um estorno (o caixa pode ficar negativo), cancela as compras abertas de quem não cobre e
 * depois dele só vende.
 */
describe("classificação e rebaixamento no fechamento (valores de 2026-11-20)", () => {
  const t = useTestDatabase(12);
  const clock = new FixedClock(ROUND10_CLOSE);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  let settle: SettleCreditsService;
  const scene = correctionScene(() => t.db, () => app, clock, 2040);

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
    });
    settle = app.get(SettleCreditsService, { strict: false });
    await scene.init();
  });
  afterAll(async () => {
    await settle?.whenIdle();
    await app?.close();
  });

  /** Os quatro últimos: CAM3 (17º) e VAS3 (18º) são listados; JUV3 e RBB3 não são. */
  const RELEGATED = ["CAM3", "VAS3", "JUV3", "RBB3"];
  const TOP = ["FLA3", "PAL3", "SAO3", "INT3", "CRU3", "BAH3", "COR3"];
  // a Série A tem 20 clubes (a cena tem mais clubes que isso)
  const ALL = [...new Set([...TOP, ...RELEGATED, ...LISTED, ...UNLISTED])].slice(0, 20);
  const OFFICIAL = [...TOP, ...ALL.filter((c) => !TOP.includes(c) && !RELEGATED.includes(c)), ...RELEGATED];

  async function season(confirmed: boolean) {
    const s = await scene.newSeason();
    await scene.insertMatches(scene.round10(s.seasonId));
    await t.db.insert(standings).values(
      OFFICIAL.map((ticker, i) => ({
        seasonId: s.seasonId,
        competition: "brasileirao-a",
        clubId: scene.club(ticker),
        position: i + 1,
        points: 0,
        confirmedBy: confirmed ? scene.admin.id : null,
        confirmedAt: confirmed ? after(ROUND10_CLOSE, 1) : null,
      })),
    );
    // o admin marcou: FLA3 e SAO3 vão à Libertadores, COR3 e SAO3 à Sul-Americana (SAO3 nas duas recebe só a Libertadores)
    await t.db.insert(seasonQualifications).values([
      { seasonId: s.seasonId, clubId: scene.club("FLA3"), cup: "libertadores" },
      { seasonId: s.seasonId, clubId: scene.club("SAO3"), cup: "libertadores" },
      { seasonId: s.seasonId, clubId: scene.club("SAO3"), cup: "sulamericana" },
      { seasonId: s.seasonId, clubId: scene.club("COR3"), cup: "sulamericana" },
    ]);
    return s;
  }

  const kindsOf = async (seasonId: number, ticker: string) => (await scene.currentOf(seasonId, ticker)).map((e) => `${e.kind}:${e.perShare}:${e.status}`).sort();

  it("os eventos nascem com os valores novos, e sem a tabela conferida só os pontos são aprovados", async () => {
    const s = await season(false);
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    expect(await kindsOf(s.seasonId, "FLA3")).toEqual(["placement:1000:pending", "points:30:pending", "qualification:300:pending"]);
    // quem está nas duas listas recebe só o da Libertadores; COR3 só o da Sul-Americana
    expect(await kindsOf(s.seasonId, "SAO3")).toEqual(["placement:500:pending", "points:10:pending", "qualification:300:pending"]);
    expect(await kindsOf(s.seasonId, "COR3")).toEqual(["placement:300:pending", "points:10:pending", "qualification:100:pending"]);
    // os rebaixados listados têm o débito de R$ 1,00 por ação; os não listados (JUV3, RBB3) não têm evento
    expect(await kindsOf(s.seasonId, "CAM3")).toEqual(["points:30:pending", "relegation:-100:pending"]);
    expect(await kindsOf(s.seasonId, "VAS3")).toEqual(["points:30:pending", "relegation:-100:pending"]);
    expect(await scene.currentOf(s.seasonId, "JUV3")).toEqual([]);

    const { results } = await app.get(ApproveService, { strict: false }).approve(scene.admin.id, { all: true });
    const blocked = results.filter((r) => r.outcome === "standings_not_confirmed").length;
    const approved = results.filter((r) => r.outcome === "approved").length;
    // colocação (16 listados no meio e no topo) + classificação (3) + rebaixamento (2) ficam bloqueados; os pontos passam
    expect(blocked).toBeGreaterThanOrEqual(5);
    expect(approved).toBeGreaterThan(0);
    expect((await scene.currentOf(s.seasonId, "CAM3")).find((e) => e.kind === "relegation")!.status).toBe("pending");
  });

  it("o débito do rebaixamento deixa o caixa negativo, cancela as compras de quem não cobre e depois só vende", async () => {
    const s = await season(true);
    // Bruno: 2.000 CAM3 (R$ 2.000,00), caixa R$ 1.000,00 e uma compra aberta que reserva R$ 500,00
    const bruno = await scene.player(s, 300_000);
    await scene.buy(s, bruno, "CAM3", 2_000);
    await scene.setLastPrice(s, "PAL3", 5_000);
    const buyId = await scene.placeOk(s, bruno, "PAL3", "buy", 10, 5_000, after(ROUND10_CLOSE, 1));
    expect(await scene.walletOf(bruno)).toMatchObject({ cash: 100_000, reservedCash: 50_000, openOrders: 1 });
    // Dora: 100 VAS3 e muito caixa, com uma compra aberta: o débito de R$ 100,00 cabe no caixa livre
    const dora = await scene.player(s, 5_000_000);
    await scene.buy(s, dora, "VAS3", 100);
    const doraBuy = await scene.placeOk(s, dora, "PAL3", "buy", 10, 5_000, after(ROUND10_CLOSE, 1));
    // Carla: 100 FLA3 recebe a colocação e o bônus da Libertadores
    const carla = await scene.player(s, 5_000_000);
    await scene.buy(s, carla, "FLA3", 100);
    const carlaCash = await scene.cashOf(carla);

    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await scene.approveAll(after(ROUND10_CLOSE, 5));

    // Bruno: +R$ 600,00 de pontos do CAM3 (3 pontos × R$ 0,10 × 2.000) e −R$ 2.000,00 do rebaixamento: R$ 1.000,00 + 600 − 2.000 = −R$ 400,00
    expect(await scene.walletOf(bruno)).toMatchObject({ cash: -40_000, reservedCash: 0, openOrders: 0 });
    expect(await scene.orderOf(buyId)).toMatchObject({ status: "cancelled", cancelReason: "reversal", reservedCash: 0 });
    const debit = (await scene.entriesOf(bruno, ["reversal"])).at(-1)!;
    expect(debit).toMatchObject({ kind: "reversal", cashDelta: -200_000, cashAfter: -40_000 });
    expect(debit.reason).toContain("rebaixamento: 17º lugar");
    // Dora: o caixa livre cobre o débito, então a compra dela fica aberta (e o caixa não fica negativo)
    expect(await scene.orderOf(doraBuy)).toMatchObject({ status: "open" });
    expect((await scene.walletOf(dora)).cash).toBeGreaterThan(0);
    const doraDebit = (await scene.entriesOf(dora, ["reversal"]))[0]!;
    expect(doraDebit.cashDelta).toBe(-10_000);
    // Carla: pontos (6) + colocação (R$ 10,00) + Libertadores (R$ 3,00) por ação
    expect((await scene.cashOf(carla)) - carlaCash).toBe(100 * (30 + 1000 + 300));

    // com o caixa negativo, comprar é recusado; vender continua aceito
    const refused = await scene.place(s, bruno, "PAL3", "buy", 1, 5_000, after(ROUND10_CLOSE, 10));
    expect(refused).toMatchObject({ ok: false, code: "negative_cash" });
    await scene.setLastPrice(s, "CAM3", 100);
    const sold = await scene.place(s, bruno, "CAM3", "sell", 10, 100, after(ROUND10_CLOSE, 10));
    expect(sold.ok).toBe(true);

    // a recompra não conta a penalização: só pontos, colocação e o bônus entram na base
    await assertLedgerConsistent(t.db, s.seasonId);
    await assertSharesConserved(t.db, s.seasonId);
  });

  it("o caixa zerado também só vende", async () => {
    const s = await season(true);
    const eva = await scene.player(s, 100 * PRICE);
    await scene.buy(s, eva, "FLA3", 100); // gasta tudo: caixa R$ 0,00
    expect(await scene.cashOf(eva)).toBe(0);
    await scene.setLastPrice(s, "FLA3", 100);
    await scene.setLastPrice(s, "PAL3", 5_000);
    expect(await scene.place(s, eva, "PAL3", "buy", 1, 5_000, after(ROUND10_CLOSE, 10))).toMatchObject({ ok: false, code: "negative_cash" });
    expect(await scene.place(s, eva, "FLA3", "sell", 1, 100, after(ROUND10_CLOSE, 10))).toMatchObject({ ok: true });
  });

  it("mudar a marcação dos classificados refaz o bônus na próxima passada, antes de aprovado", async () => {
    const s = await season(true);
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    expect(await kindsOf(s.seasonId, "COR3")).toContain("qualification:100:pending");
    await t.db.delete(seasonQualifications).where(and(eq(seasonQualifications.seasonId, s.seasonId), eq(seasonQualifications.clubId, scene.club("COR3"))));
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 4));
    expect((await kindsOf(s.seasonId, "COR3")).some((k) => k.startsWith("qualification"))).toBe(false);
  });
});
