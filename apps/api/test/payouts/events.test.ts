import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payoutCreditedEventSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { EventBus, meChannel, type BusEvent } from "../../src/infra/realtime/index.js";
import { wallets } from "../../src/infra/db/schema/index.js";
import { PayoutsStatusService } from "../../src/modules/admin/payouts/outstanding.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { RefreshWaker } from "../../src/modules/market/index.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { after, correctionScene, ROUND10_CLOSE, SilentWaker } from "./correction-scene.js";

const frames = (events: BusEvent[]) => events.map((e) => JSON.parse(e.frame) as { type: string; data: Record<string, unknown> });
const settle = () => new Promise((r) => setTimeout(r, 80));

describe("avisos, consultas e visão geral dos pagamentos (T9)", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(ROUND10_CLOSE);
  let app: NestFastifyApplication;
  let bus: EventBus;
  let status: PayoutsStatusService;
  const scene = correctionScene(() => t.db, () => app, clock);

  const ownerOf = async (walletId: number) => {
    const rows = await t.db.select({ userId: wallets.userId }).from(wallets).where(eq(wallets.id, walletId));
    return rows[0]!.userId!;
  };

  beforeAll(async () => {
    app = await createTestApp({ db: t.db, clock, override: (b) => withTestAuth(clock)(b).overrideProvider(RefreshWaker).useValue(new SilentWaker()) });
    bus = app.get(EventBus, { strict: false });
    status = app.get(PayoutsStatusService, { strict: false });
    await scene.init();
  });
  afterAll(async () => {
    await app.get(SettleCreditsService, { strict: false }).whenIdle();
    await app?.close();
  });

  it("admin 21 e 16: pendente em outstanding e perShareTotals; aprovado migra para o pago; payout.credited só ao dono; overview", async () => {
    const s = await scene.newSeason();
    const ana = await scene.player(s);
    await scene.buy(s, ana, "CAM3", 1_000);
    const outsider = await scene.player(s);
    await scene.insertMatches(scene.round10(s.seasonId));
    const adminFrames: BusEvent[] = [];
    bus.subscribe("admin", (e) => adminFrames.push(e));
    const mine: BusEvent[] = [];
    const others: BusEvent[] = [];
    bus.subscribe(meChannel(await ownerOf(ana)), (e) => mine.push(e));
    bus.subscribe(meChannel(await ownerOf(outsider)), (e) => others.push(e));

    await scene.close(s.seasonId, after(ROUND10_CLOSE, 3));
    await settle();
    const t3 = after(ROUND10_CLOSE, 3);
    expect(await status.perShareTotals(s.seasonId, scene.club("CAM3"), t3)).toEqual({ paid: 0, toReceive: 30 });
    const open = await status.outstanding(s.seasonId, t3);
    expect(open.pending).toBeGreaterThan(0);
    expect(open.settling).toBe(0);
    expect(open.correctionEvents).toBe(0);
    // o fechamento avisou o admin com o número de pagamentos aguardando
    expect(frames(adminFrames).filter((f) => f.type === "admin.pending").at(-1)!.data.pendingPayouts).toBe(open.pending);

    await scene.approveAll(after(ROUND10_CLOSE, 5));
    await settle();
    const credited = frames(mine).filter((f) => f.type === "payout.credited");
    expect(credited).toHaveLength(1);
    expect(payoutCreditedEventSchema.parse(credited[0]!.data)).toMatchObject({ kind: "dividend", ticker: "CAM3", amount: 30_000 });
    expect(frames(others).filter((f) => f.type === "payout.credited")).toEqual([]);

    const t6 = after(ROUND10_CLOSE, 6);
    expect(await status.perShareTotals(s.seasonId, scene.club("CAM3"), t6)).toEqual({ paid: 30, toReceive: 0 });
    expect(await status.outstanding(s.seasonId, t6)).toEqual({ pending: 0, settling: 0, correctionEvents: 0 });
    expect(frames(adminFrames).filter((f) => f.type === "admin.pending").at(-1)!.data.pendingPayouts).toBe(0);

    // um placar corrigido depois do pagamento deixa uma correção a aplicar
    await scene.setScore(s.seasonId, "CAM3", [1, 1]);
    expect((await status.outstanding(s.seasonId, after(ROUND10_CLOSE, 7))).correctionEvents).toBeGreaterThan(0);
    const overview = await app.inject({
      method: "GET",
      url: "/admin/overview",
      headers: { authorization: `Bearer ${await scene.admin.tokenWith({ at: ROUND10_CLOSE })}` },
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ pendingPayouts: 0, settlingPayouts: 0, correctionToApply: true });
  });
});
