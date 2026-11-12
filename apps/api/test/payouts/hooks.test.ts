import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { ApplyCorrectionService } from "../../src/modules/admin/payouts/apply-correction.service.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { after, CALLS, correctionScene, prepareCalls, RecordingRankings, ROUND10_CLOSE, SilentWaker } from "./correction-scene.js";

/**
 * Contrato do `RankingsPort` para a F13 (admin 16 e 36): `payoutsChanged` é chamado com o `tx`, dentro da transação, em
 * toda transação que cria, muda de versão, aprova ou corrige um evento; `wake()` só depois do `COMMIT`.
 */
describe("RankingsPort: contrato para a F13 (admin 16 e 36)", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(ROUND10_CLOSE);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  const scene = correctionScene(() => t.db, () => app, clock);

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
    await app.get(SettleCreditsService, { strict: false }).whenIdle();
    await app?.close();
  });
  const reset = async () => {
    rankings.reset();
    await t.db.execute(sql`delete from ${CALLS}`);
  };
  beforeEach(async () => {
    await reset();
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  /** Cada aviso foi gravado pelo `tx` (a tabela de teste o vê) e cada `wake()` viu os avisos já confirmados. */
  const expectContract = async () => {
    expect(rankings.changes.length).toBeGreaterThanOrEqual(1);
    expect(rankings.wakes.length).toBeGreaterThanOrEqual(1);
    const { rows } = await t.db.execute(sql`select count(*)::int as n from ${CALLS} where port = 'rankings'`);
    expect(Number(rows[0]!.n)).toBe(rankings.changes.length);
    for (const w of rankings.wakes) expect(w.visible).toBeGreaterThanOrEqual(1);
    for (const c of rankings.changes) expect(c.closedAts.length).toBeGreaterThan(0);
  };

  it("admin 16: criar, mudar de versão, aprovar e corrigir um evento avisam os rankings com o tx e acordam depois do COMMIT", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    await scene.buy(s, ana, "CAM3", 1_000);
    await scene.insertMatches(scene.round10(s.seasonId));

    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await expectContract();

    await reset();
    await scene.setScore(s.seasonId, "CAM3", [1, 1]);
    await scene.close(s.seasonId, after(ROUND10_CLOSE, 4));
    await expectContract();

    await reset();
    await scene.approveAll(after(ROUND10_CLOSE, 5));
    await expectContract();

    await reset();
    await scene.setScore(s.seasonId, "CAM3", [0, 2]);
    const now = after(ROUND10_CLOSE, 60);
    const p = await scene.plan(s.seasonId, now);
    clock.set(now);
    await app.get(ApplyCorrectionService, { strict: false }).apply(scene.admin.id, { planCode: p.planCode, reason: "súmula corrigida" });
    await expectContract();
    expect(rankings.changes.at(-1)!.closedAts.map((d) => d.toISOString())).toContain(ROUND10_CLOSE.toISOString());
  });
});
