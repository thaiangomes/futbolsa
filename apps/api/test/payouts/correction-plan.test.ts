import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { correctionPreviewSchema } from "@futbolsa/contracts";
import { CLUBS } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { bots, matches, orders, payoutCredits, payoutEvents, payoutHoldings, seasons, users, wallets } from "../../src/infra/db/schema/index.js";
import { DomainError } from "../../src/infra/http/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { CloseEventsService } from "../../src/modules/admin/payouts/close-events.service.js";
import { type CorrectionPlan, CorrectionPlanService } from "../../src/modules/admin/payouts/correction-plan.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openWallets, seedSeason, T0 } from "../support/fixtures.js";

const MIN = 60_000;
const TOTAL = 10_000;
/** Todos os clubes do seed menos JUV3 e RBB3, que ficam fora da lista da temporada. */
const UNLISTED = ["JUV3", "RBB3"];
const LISTED = CLUBS.map((c) => c.id).filter((t) => !UNLISTED.includes(t));
/** Preço de R$ 1,00 por ação nos negócios de teste. */
const PRICE = 100;
/** R$ 100.000,00. */
const RICH = 10_000_000;

const at = (iso: string) => new Date(iso);
const after = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN);

describe("plano da correção de pagamentos (GET /admin/payouts/corrections)", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(T0);
  let app: NestFastifyApplication;
  let service: CorrectionPlanService;
  let closer: CloseEventsService;
  let admin: TestAccount;
  let clubIds: Map<string, number>;
  let year = 2030;

  beforeAll(async () => {
    app = await createTestApp({ db: t.db, clock, override: (b) => withTestAuth(clock)(b) });
    service = app.get(CorrectionPlanService, { strict: false });
    closer = app.get(CloseEventsService, { strict: false });
    admin = await createAccount(t.db, { role: "admin" });
    ({ clubIds } = await seedSeason(t.db, 2029));
  });
  afterAll(() => app?.close());

  const club = (ticker: string) => clubIds.get(ticker)!;

  interface Season {
    seasonId: number;
    treasury: number;
  }

  /** Uma temporada nova (a mais nova de todas, então é a atual): os 18 clubes listados, os valores padrão e a tesouraria com as ações. */
  async function newSeason(): Promise<Season> {
    const { seasonId } = await seedSeason(t.db, year++);
    await listClubs(t.db, seasonId, clubIds, LISTED, TOTAL);
    const values = app.get(SeasonValuesService, { strict: false });
    await withTransaction(t.db, (tx) => values.createInitial(tx, seasonId).then(() => undefined));
    const [treasury] = await openWallets(t.db, seasonId, [{ type: "treasury" }]);
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [treasury!]);
      for (const ticker of LISTED) {
        await post(tx, { walletId: treasury!, at: T0, kind: "adjustment", clubId: club(ticker), sharesDelta: TOTAL, price: 4000, costBasis: "purchase", reason: "emissão" });
      }
    });
    return { seasonId, treasury: treasury! };
  }

  /** Um jogador (ativo, bloqueado ou de conta excluída) com o caixa inicial dado. */
  async function player(s: Season, cash = RICH, status: "active" | "blocked" | "deleted" = "active"): Promise<number> {
    const account = await createAccount(t.db, { status });
    const [id] = await openWallets(t.db, s.seasonId, [{ type: "user", userId: account.id }], cash);
    return id!;
  }

  async function bot(s: Season, cash = RICH): Promise<number> {
    const [row] = await t.db.insert(bots).values({ profile: "dividendos", active: true }).returning({ id: bots.id });
    const [id] = await openWallets(t.db, s.seasonId, [{ type: "bot", botId: row!.id }], cash);
    return id!;
  }

  /** A carteira compra ações da tesouraria a R$ 1,00 no instante dado (pelo extrato, como um negócio). */
  async function buy(s: Season, walletId: number, ticker: string, shares: number, when: Date = T0) {
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [s.treasury, walletId]);
      await post(tx, { walletId: s.treasury, at: when, kind: "trade", clubId: club(ticker), sharesDelta: -shares, cashDelta: shares * PRICE, price: PRICE, costBasis: "sale" });
      await post(tx, { walletId, at: when, kind: "trade", clubId: club(ticker), sharesDelta: shares, cashDelta: -shares * PRICE, price: PRICE, costBasis: "purchase" });
    });
  }

  /** Uma carteira passa ações a outra no instante dado. */
  async function transfer(from: number, to: number, ticker: string, shares: number, when: Date) {
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [from, to]);
      await post(tx, { walletId: from, at: when, kind: "trade", clubId: club(ticker), sharesDelta: -shares, cashDelta: shares * PRICE, price: PRICE, costBasis: "sale" });
      await post(tx, { walletId: to, at: when, kind: "trade", clubId: club(ticker), sharesDelta: shares, cashDelta: -shares * PRICE, price: PRICE, costBasis: "purchase" });
    });
  }

  /** Uma ordem aberta inserida direto (a F9 ainda não está aqui); a compra reserva o caixa pelo extrato. */
  async function openOrder(s: Season, walletId: number, ticker: string, side: "buy" | "sell", quantity: number, reserve: number) {
    if (side === "buy") {
      await withTransaction(t.db, async (tx) => {
        await lockWallets(tx, [walletId]);
        await post(tx, { walletId, at: T0, kind: "order_reserve", reservedCashDelta: reserve, openOrdersDelta: 1 });
      });
    }
    await t.db.insert(orders).values({
      seasonId: s.seasonId,
      clubId: club(ticker),
      walletId,
      side,
      type: "limit",
      quantity,
      limitPrice: PRICE,
      reservedCash: side === "buy" ? reserve : 0,
      status: "open",
      createdAt: T0,
      updatedAt: T0,
    });
  }

  type MatchInsert = typeof matches.$inferInsert;
  const game = (seasonId: number, round: number, home: string, away: string, score: [number, number], kickoff: Date): MatchInsert => ({
    seasonId,
    competition: "brasileirao-a",
    round,
    homeClubId: club(home),
    awayClubId: club(away),
    kickoff,
    finishedAt: new Date(kickoff.getTime() + 120 * MIN),
    homeGoals: score[0],
    awayGoals: score[1],
    status: "finished",
  });

  /** A rodada 10 do critério 12: 10 jogos, o último (JUV3 × RBB3) terminando às 20h (UTC) de 06/06/2027. */
  const ROUND10_CLOSE = at("2027-06-06T20:00:00Z");
  const round10 = (seasonId: number): MatchInsert[] => {
    const pairs: Array<[string, string, [number, number]]> = [
      ["FLA3", "PAL3", [2, 0]],
      ["CAM3", "BOT3", [2, 1]],
      ["COR3", "SAO3", [1, 1]],
      ["FLU3", "VAS3", [0, 1]],
      ["SAN3", "GRE3", [3, 0]],
      ["INT3", "CRU3", [0, 0]],
      ["BAH3", "FOR3", [1, 2]],
      ["CEA3", "SPT3", [2, 2]],
      ["VIT3", "MIR3", [1, 0]],
      ["JUV3", "RBB3", [0, 0]],
    ];
    return pairs.map(([home, away, score], i) =>
      game(seasonId, 10, home, away, score, new Date(ROUND10_CLOSE.getTime() - 120 * MIN - (9 - i) * 10 * MIN)),
    );
  };
  const insertMatches = (rows: MatchInsert[]) => t.db.insert(matches).values(rows).returning();
  const matchOf = async (seasonId: number, home: string) =>
    (await t.db.select().from(matches).where(and(eq(matches.seasonId, seasonId), eq(matches.homeClubId, club(home)))))[0]!;
  const setScore = async (seasonId: number, home: string, score: [number, number]) =>
    t.db.update(matches).set({ homeGoals: score[0], awayGoals: score[1] }).where(eq(matches.id, (await matchOf(seasonId, home)).id));

  const close = (seasonId: number, now: Date) => {
    clock.set(now);
    return closer.closeEvents(seasonId, now);
  };

  /**
   * Aprova à mão os pendentes (a aprovação é da T5) e, com `settle`, credita cada jogador (inclusive o bloqueado) e
   * bot da foto pelo `portfolio.post`, com a linha em `payout_credits` (o estado "liquidado"). A conta excluída não recebe (P6).
   */
  async function approve(seasonId: number, o: { settle?: boolean; only?: string[] } = {}) {
    const pending = await t.db
      .select()
      .from(payoutEvents)
      .where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.status, "pending")))
      .orderBy(asc(payoutEvents.id));
    const chosen = pending.filter((e) => !o.only || o.only.some((ticker) => e.clubId === club(ticker)));
    for (const e of chosen) {
      await t.db.update(payoutEvents).set({ status: "approved", approvedAt: after(e.closedAt, 5) }).where(eq(payoutEvents.id, e.id));
      if (o.settle === false) continue;
      const holders = await t.db
        .select({ walletId: payoutHoldings.walletId, shares: payoutHoldings.shares, ownerType: wallets.ownerType, status: users.status })
        .from(payoutHoldings)
        .innerJoin(wallets, eq(wallets.id, payoutHoldings.walletId))
        .leftJoin(users, eq(users.id, wallets.userId))
        .where(eq(payoutHoldings.eventId, e.id));
      const receivers = holders.filter((h) => h.ownerType === "bot" || (h.ownerType === "user" && h.status !== "deleted"));
      if (receivers.length === 0) continue;
      await withTransaction(t.db, async (tx) => {
        await lockWallets(tx, receivers.map((h) => h.walletId).sort((a, b) => a - b));
        for (const h of receivers) {
          const amount = h.shares * e.perShare;
          const { entry } = await post(tx, { walletId: h.walletId, at: after(e.closedAt, 5), kind: "dividend", clubId: e.clubId, cashDelta: amount, ref: { type: "payout_event", id: e.id }, reason: e.reason });
          await tx.db.insert(payoutCredits).values({ eventId: e.id, walletId: h.walletId, amount, entryId: entry.id });
        }
      });
    }
    return chosen;
  }

  const plan = (seasonId: number, now: Date) => {
    clock.set(now);
    return service.plan(t.db, seasonId, now);
  };
  const changeOf = (p: CorrectionPlan, ticker: string) => p.preview.changes.find((c) => c.club.ticker === ticker);
  const walletOf = (p: CorrectionPlan, walletId: number) => p.wallets.find((w) => w.walletId === walletId);
  const eventsOf = (seasonId: number, ticker: string) =>
    t.db.select().from(payoutEvents).where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.clubId, club(ticker)))).orderBy(asc(payoutEvents.id));

  const domainCode = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return (error as DomainError).code;
    }
    throw new Error("era para recusar");
  };

  it("admin 12 e 13: a prévia da correção de 2 × 1 para 1 × 1 mostra −R$ 0,20 no CAM3 e +R$ 0,10 no BOT3, Bruno −R$ 400,00 e Carla +R$ 100,00", async () => {
    const s = await newSeason();
    // Bruno: 2.000 CAM3 no fechamento e R$ 150,00 no caixa na hora da correção (gastou o dividendo em FLA3)
    const bruno = await player(s, 15_000 + 2_000 * PRICE);
    await buy(s, bruno, "CAM3", 2_000);
    const carla = await player(s);
    await buy(s, carla, "BOT3", 1_000);
    // Dani devolve também, mas o caixa livre cobre: a compra aberta dela fica
    const dani = await player(s);
    await buy(s, dani, "CAM3", 100);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    await approve(s.seasonId);
    await buy(s, bruno, "FLA3", 600, after(ROUND10_CLOSE, 30));
    // Bruno tem duas compras abertas (R$ 100,00 reservados) e uma venda; o caixa livre (R$ 50,00) não cobre os R$ 400,00
    await openOrder(s, bruno, "PAL3", "buy", 50, 5_000);
    await openOrder(s, bruno, "SAO3", "buy", 50, 5_000);
    await openOrder(s, bruno, "CAM3", "sell", 100, 0);
    await openOrder(s, dani, "PAL3", "buy", 10, 1_000);
    const [brunoCash] = await t.db.select({ cash: wallets.cash, reserved: wallets.reservedCash }).from(wallets).where(eq(wallets.id, bruno));
    expect(brunoCash).toEqual({ cash: 15_000, reserved: 10_000 });

    await setScore(s.seasonId, "CAM3", [1, 1]);
    const now = after(ROUND10_CLOSE, 60);
    const p = await plan(s.seasonId, now);
    const camEvent = (await eventsOf(s.seasonId, "CAM3"))[0]!;

    expect(p.preview.changes).toHaveLength(2);
    expect(changeOf(p, "CAM3")).toEqual({
      key: "points|brasileirao-a|10|CAM3",
      kind: "points",
      club: { id: club("CAM3"), ticker: "CAM3", name: expect.any(String) },
      competition: "brasileirao-a",
      round: 10,
      phase: null,
      reason: expect.stringContaining("rodada 10"),
      before: 30,
      after: 10,
      delta: -20,
      closedAtBefore: ROUND10_CLOSE.toISOString(),
      closedAtAfter: ROUND10_CLOSE.toISOString(),
      shares: 2_100,
      total: -42_000,
      outcome: "correction",
    });
    expect(changeOf(p, "BOT3")).toMatchObject({
      key: "points|brasileirao-a|10|BOT3",
      before: 0,
      after: 10,
      delta: 10,
      closedAtBefore: null,
      closedAtAfter: ROUND10_CLOSE.toISOString(),
      shares: 1_000,
      total: 10_000,
      outcome: "new_in_paid_group",
    });
    expect(p.preview.wallets).toEqual({ receive: 1, pay: 2, negative: 1, buysCancelled: 2 });
    expect(p.preview.months).toEqual(["2027-06"]);
    expect(p.preview.planCode).toMatch(/^[0-9a-f]{64}$/);

    // o plano interno, para a T7 aplicar sem refazer a conta
    expect(walletOf(p, bruno)).toMatchObject({
      amount: -40_000,
      cash: 15_000,
      reservedCash: 10_000,
      cancelBuys: true,
      openBuys: 2,
      cashAfter: -25_000,
      events: [{ key: "points|brasileirao-a|10|CAM3", clubId: club("CAM3"), amount: -40_000, items: [expect.objectContaining({ kind: "reversal", amount: -40_000, perShareDelta: -20 })] }],
    });
    expect(walletOf(p, carla)).toMatchObject({
      amount: 10_000,
      cancelBuys: false,
      events: [{ key: "points|brasileirao-a|10|BOT3", clubId: club("BOT3"), amount: 10_000, items: [expect.objectContaining({ kind: "complement", amount: 10_000 })] }],
    });
    // Dani cobre o estorno com o caixa livre: a compra aberta dela não conta (não será cancelada)
    expect(walletOf(p, dani)).toMatchObject({ amount: -2_000, cancelBuys: false, openBuys: 0 });
    expect(p.wallets.map((w) => w.walletId)).not.toContain(s.treasury);
    const cam = p.events.find((e) => e.ticker === "CAM3")!;
    expect(cam).toMatchObject({
      clubId: club("CAM3"),
      outcome: "correction",
      current: { id: camEvent.id, version: 1, perShare: 30 },
      next: { key: "points|brasileirao-a|10|CAM3", perShare: 10, closedAt: ROUND10_CLOSE.getTime() },
      photo: { kind: "copy", fromEventId: camEvent.id },
    });
    const bot3 = p.events.find((e) => e.ticker === "BOT3")!;
    expect(bot3).toMatchObject({ current: null, outcome: "new_in_paid_group", next: { perShare: 10 } });
    expect(bot3.photo).toEqual({ kind: "new", holdings: [{ walletId: carla, shares: 1_000 }] });
    expect(p.closedAts).toEqual([ROUND10_CLOSE]);

    // nada foi gravado: o plano só lê
    expect(await eventsOf(s.seasonId, "CAM3")).toHaveLength(1);
    expect(await eventsOf(s.seasonId, "BOT3")).toEqual([]);

    // a rota devolve a mesma prévia, da temporada atual (a mais nova)
    clock.set(now);
    const token = await admin.tokenWith({ at: now });
    const res = await app.inject({ method: "GET", url: "/admin/payouts/corrections", headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(correctionPreviewSchema.parse(res.json())).toEqual(p.preview);
  });

  it("evento novo em rodada já paga entra na correção, e em rodada ainda pendente vira pending pela passada de fechamento (T3)", async () => {
    const s = await newSeason();
    const carla = await player(s);
    await buy(s, carla, "BOT3", 1_000);
    await buy(s, carla, "CAM3", 500);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    // só o CAM3 foi aprovado na rodada 10: o grupo já é pago
    await approve(s.seasonId, { only: ["CAM3"] });
    // rodada 11 fechada e ainda pendente
    const r11 = at("2027-06-13T21:00:00Z");
    await insertMatches([game(s.seasonId, 11, "BOT3", "CAM3", [1, 0], r11)]);
    await close(s.seasonId, after(r11, 125));

    // rodada 10: BOT3 passa a pontuar (grupo pago); rodada 11: CAM3 passa a pontuar (grupo pendente)
    await setScore(s.seasonId, "CAM3", [1, 1]);
    await setScore(s.seasonId, "BOT3", [1, 1]);
    const p = await plan(s.seasonId, after(r11, 200));
    expect(p.preview.changes.map((c) => [c.key, c.outcome, c.before, c.after])).toEqual([
      ["points|brasileirao-a|10|BOT3", "new_in_paid_group", 0, 10],
      ["points|brasileirao-a|10|CAM3", "correction", 30, 10],
    ]);
    // a rodada 10 dos outros clubes (FLA3, pendente) não entra: o pendente é da passada de fechamento
    expect(p.preview.changes.some((c) => c.round === 11)).toBe(false);

    const summary = await close(s.seasonId, after(r11, 200));
    expect(summary.created).toBe(1);
    expect(await eventsOf(s.seasonId, "CAM3")).toEqual([
      expect.objectContaining({ round: 10, status: "approved" }),
      expect.objectContaining({ round: 11, status: "pending", perShare: 10 }),
    ]);
    // e o plano continua o mesmo depois da passada
    expect((await plan(s.seasonId, after(r11, 201))).preview.planCode).toBe(p.preview.planCode);
  });

  it("fechamento que mudou estorna pela foto antiga e paga pela nova (valor igual, fechamento diferente)", async () => {
    const s = await newSeason();
    const bruno = await player(s);
    const dani = await player(s);
    await buy(s, bruno, "CAM3", 2_000);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    await approve(s.seasonId);
    // depois do fechamento das 20h, Bruno passa 500 CAM3 a Dani às 20h10; o último jogo na verdade acabou às 20h30
    await transfer(bruno, dani, "CAM3", 500, after(ROUND10_CLOSE, 10));
    const late = after(ROUND10_CLOSE, 30);
    await t.db.update(matches).set({ finishedAt: late }).where(eq(matches.id, (await matchOf(s.seasonId, "JUV3")).id));

    const p = await plan(s.seasonId, after(ROUND10_CLOSE, 60));
    // os 12 eventos da rodada mudam de fechamento; só o CAM3 tem donos fora da tesouraria
    expect(p.preview.changes).toHaveLength(12);
    expect(changeOf(p, "CAM3")).toMatchObject({
      before: 30,
      after: 30,
      delta: 0,
      closedAtBefore: ROUND10_CLOSE.toISOString(),
      closedAtAfter: late.toISOString(),
      shares: 2_000,
      total: 0,
      outcome: "correction",
    });
    expect(walletOf(p, bruno)).toMatchObject({
      amount: -15_000,
      events: [
        {
          key: "points|brasileirao-a|10|CAM3",
          amount: -15_000,
          items: [
            expect.objectContaining({ kind: "reversal", amount: -60_000, perShareDelta: -30 }),
            expect.objectContaining({ kind: "complement", amount: 45_000, perShareDelta: 30 }),
          ],
        },
      ],
    });
    expect(walletOf(p, dani)).toMatchObject({ amount: 15_000, events: [expect.objectContaining({ amount: 15_000 })] });
    expect(p.preview.wallets).toMatchObject({ receive: 1, pay: 1, negative: 0, buysCancelled: 0 });
    const cam = p.events.find((e) => e.ticker === "CAM3")!;
    expect(cam.photo).toEqual({ kind: "new", holdings: [{ walletId: bruno, shares: 1_500 }, { walletId: dani, shares: 500 }] });
    expect(cam.lines.map((l) => [l.before, l.after, l.delta])).toEqual([
      [30, 0, -30],
      [0, 30, 30],
    ]);
    expect(p.closedAts).toEqual([ROUND10_CLOSE, late]);
  });

  it("fechamento que mudou com o valor também mudado: estorno do antigo pela foto antiga e o novo pela foto nova", async () => {
    const s = await newSeason();
    const bruno = await player(s);
    const dani = await player(s);
    const carla = await player(s);
    await buy(s, bruno, "CAM3", 2_000);
    await buy(s, carla, "BOT3", 1_000);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    await approve(s.seasonId);
    await transfer(bruno, dani, "CAM3", 500, after(ROUND10_CLOSE, 10));
    const late = after(ROUND10_CLOSE, 30);
    await t.db.update(matches).set({ finishedAt: late }).where(eq(matches.id, (await matchOf(s.seasonId, "JUV3")).id));
    await setScore(s.seasonId, "CAM3", [1, 1]);

    const p = await plan(s.seasonId, after(ROUND10_CLOSE, 60));
    expect(changeOf(p, "CAM3")).toMatchObject({ before: 30, after: 10, delta: -20, shares: 2_000, total: -60_000 + 20_000, outcome: "correction" });
    // Bruno: −30 × 2.000 + 10 × 1.500; Dani: 10 × 500; Carla: o BOT3 novo pela foto das 20h30
    expect(walletOf(p, bruno)).toMatchObject({ amount: -45_000 });
    expect(walletOf(p, dani)).toMatchObject({ amount: 5_000 });
    expect(walletOf(p, carla)).toMatchObject({ amount: 10_000 });
    expect(changeOf(p, "BOT3")).toMatchObject({ closedAtAfter: late.toISOString(), outcome: "new_in_paid_group", total: 10_000 });
  });

  it("evento que sumiu vai a R$ 0,00 (vanished), e a vitória virando empate corrige o valor", async () => {
    const s = await newSeason();
    const ana = await player(s);
    await buy(s, ana, "COR3", 1_000);
    await buy(s, ana, "FLA3", 1_000);
    await buy(s, ana, "SAO3", 100);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    await approve(s.seasonId);

    // COR3 1 × 1 SAO3 vira 0 × 1: o COR3 perde o ponto (o evento some); FLA3 2 × 0 PAL3 vira 0 × 0
    await setScore(s.seasonId, "COR3", [0, 1]);
    await setScore(s.seasonId, "FLA3", [0, 0]);
    const p = await plan(s.seasonId, after(ROUND10_CLOSE, 60));
    const corEvent = (await eventsOf(s.seasonId, "COR3"))[0]!;
    expect(changeOf(p, "COR3")).toMatchObject({
      before: 10,
      after: 0,
      delta: -10,
      closedAtBefore: ROUND10_CLOSE.toISOString(),
      closedAtAfter: null,
      shares: 1_000,
      total: -10_000,
      outcome: "vanished",
    });
    expect(p.events.find((e) => e.ticker === "COR3")).toMatchObject({
      current: { id: corEvent.id },
      next: { key: corEvent.eventKey, perShare: 0, closedAt: ROUND10_CLOSE.getTime(), reason: corEvent.reason },
      photo: { kind: "copy", fromEventId: corEvent.id },
    });
    expect(changeOf(p, "SAO3")).toMatchObject({ before: 10, after: 30, delta: 20, total: 2_000, outcome: "correction" });
    expect(changeOf(p, "FLA3")).toMatchObject({ before: 30, after: 10, delta: -20, total: -20_000, outcome: "correction" });
    expect(changeOf(p, "PAL3")).toMatchObject({ before: 0, after: 10, outcome: "new_in_paid_group", shares: 0, total: 0 });
    expect(walletOf(p, ana)).toMatchObject({ amount: -10_000 + 2_000 - 20_000 });
  });

  it("admin 11: nada mudou dá prévia vazia, com o código estável", async () => {
    const s = await newSeason();
    const ana = await player(s);
    await buy(s, ana, "CAM3", 1_000);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    await approve(s.seasonId);
    const first = await plan(s.seasonId, after(ROUND10_CLOSE, 60));
    expect(first.preview).toEqual({
      planCode: expect.stringMatching(/^[0-9a-f]{64}$/),
      changes: [],
      wallets: { receive: 0, pay: 0, negative: 0, buysCancelled: 0 },
      months: [],
    });
    expect(first.events).toEqual([]);
    expect(first.wallets).toEqual([]);
    const second = await plan(s.seasonId, after(ROUND10_CLOSE, 90));
    expect(second.preview.planCode).toBe(first.preview.planCode);
  });

  it("o planCode muda quando um resultado muda e é igual em duas chamadas seguidas", async () => {
    const s = await newSeason();
    const ana = await player(s);
    await buy(s, ana, "CAM3", 1_000);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    await approve(s.seasonId);
    const empty = (await plan(s.seasonId, after(ROUND10_CLOSE, 60))).preview.planCode;

    await setScore(s.seasonId, "CAM3", [1, 1]);
    const a = (await plan(s.seasonId, after(ROUND10_CLOSE, 60))).preview.planCode;
    const b = (await plan(s.seasonId, after(ROUND10_CLOSE, 61))).preview.planCode;
    expect(a).toBe(b);
    expect(a).not.toBe(empty);

    await setScore(s.seasonId, "CAM3", [1, 2]);
    const c = (await plan(s.seasonId, after(ROUND10_CLOSE, 62))).preview.planCode;
    expect(c).not.toBe(a);
    expect(c).not.toBe(empty);

    // de volta ao resultado pago: nada a corrigir, o mesmo código do plano vazio
    await setScore(s.seasonId, "CAM3", [2, 1]);
    expect((await plan(s.seasonId, after(ROUND10_CLOSE, 63))).preview.planCode).toBe(empty);
  });

  it("P6: a conta excluída não recebe nem devolve na correção, e o jogador bloqueado e o bot contam", async () => {
    const s = await newSeason();
    const blocked = await player(s, RICH, "blocked");
    const gone = await player(s, RICH, "deleted");
    const robot = await bot(s);
    await buy(s, blocked, "CAM3", 200);
    await buy(s, gone, "CAM3", 300);
    await buy(s, robot, "CAM3", 100);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    await approve(s.seasonId);
    // a conta excluída está na foto, mas não recebeu
    const cam = (await eventsOf(s.seasonId, "CAM3"))[0]!;
    expect((await t.db.select().from(payoutHoldings).where(eq(payoutHoldings.eventId, cam.id))).map((h) => h.walletId)).toContain(gone);
    expect((await t.db.select().from(payoutCredits).where(eq(payoutCredits.eventId, cam.id))).map((c) => c.walletId)).not.toContain(gone);

    await setScore(s.seasonId, "CAM3", [1, 1]);
    const p = await plan(s.seasonId, after(ROUND10_CLOSE, 60));
    expect(changeOf(p, "CAM3")).toMatchObject({ delta: -20, shares: 300, total: -6_000 });
    expect(walletOf(p, blocked)).toMatchObject({ amount: -4_000 });
    expect(walletOf(p, robot)).toMatchObject({ amount: -2_000, ownerType: "bot" });
    expect(walletOf(p, gone)).toBeUndefined();
    expect(p.preview.wallets).toMatchObject({ receive: 0, pay: 2 });
    // a foto da versão nova é a da anterior (copiada): a conta excluída fica nela, só não recebe
    expect(p.events.find((e) => e.ticker === "CAM3")!.photo).toEqual({ kind: "copy", fromEventId: cam.id });
  });

  it("admin 17: título da Copa do Brasil corrigido de VAS3 para COR3: quem tinha VAS3 devolve o título e quem tinha COR3 recebe", async () => {
    const s = await newSeason();
    const ana = await player(s);
    const bruno = await player(s);
    await buy(s, ana, "VAS3", 1_000);
    await buy(s, bruno, "COR3", 500);
    const kickoff = at("2027-12-19T21:30:00-03:00");
    const [final] = await insertMatches([
      {
        seasonId: s.seasonId,
        competition: "copa-do-brasil",
        phase: "final",
        homeClubId: club("VAS3"),
        awayClubId: club("COR3"),
        kickoff,
        finishedAt: new Date(kickoff.getTime() + 120 * MIN),
        homeGoals: 1,
        awayGoals: 1,
        status: "finished",
        advancedClubId: club("VAS3"),
      },
    ]);
    const now = at("2027-12-20T12:00:00Z");
    await close(s.seasonId, now);
    const [title] = await approve(s.seasonId);
    expect(title).toMatchObject({ kind: "cup_title", clubId: club("VAS3"), perShare: 800 });

    // o admin corrige: o Corinthians foi o campeão nos pênaltis
    await t.db.update(matches).set({ advancedClubId: club("COR3") }).where(eq(matches.id, final!.id));
    const p = await plan(s.seasonId, after(now, 60));
    expect(p.preview.changes.map((c) => [c.key, c.outcome, c.before, c.after, c.total])).toEqual([
      ["cup_title|copa-do-brasil|final|COR3", "new_in_paid_group", 0, 800, 400_000],
      ["cup_title|copa-do-brasil|final|VAS3", "vanished", 800, 0, -800_000],
    ]);
    expect(walletOf(p, ana)).toMatchObject({ amount: -800_000 });
    expect(walletOf(p, bruno)).toMatchObject({ amount: 400_000 });
    expect(p.preview.months).toEqual(["2027-12"]);
  });

  it("pagamento aprovado ainda liquidando recusa o plano com 409 payout_settling", async () => {
    const s = await newSeason();
    const ana = await player(s);
    const gone = await player(s, RICH, "deleted");
    await buy(s, ana, "CAM3", 1_000);
    await buy(s, gone, "CAM3", 100);
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    // aprovado sem os créditos: ainda liquidando
    await approve(s.seasonId, { settle: false, only: ["CAM3"] });
    await setScore(s.seasonId, "CAM3", [1, 1]);
    expect(await domainCode(plan(s.seasonId, after(ROUND10_CLOSE, 60)))).toBe("payout_settling");

    clock.set(after(ROUND10_CLOSE, 60));
    const token = await admin.tokenWith({ at: clock.now() });
    const res = await app.inject({ method: "GET", url: "/admin/payouts/corrections", headers: bearer(token) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("payout_settling");

    // a conta excluída sem crédito não conta como liquidando (ela não recebe): com Ana creditada, o plano sai
    const cam = (await eventsOf(s.seasonId, "CAM3"))[0]!;
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [ana]);
      const { entry } = await post(tx, { walletId: ana, at: after(ROUND10_CLOSE, 6), kind: "dividend", clubId: club("CAM3"), cashDelta: 30_000, ref: { type: "payout_event", id: cam.id }, reason: cam.reason });
      await tx.db.insert(payoutCredits).values({ eventId: cam.id, walletId: ana, amount: 30_000, entryId: entry.id });
    });
    const p = await plan(s.seasonId, after(ROUND10_CLOSE, 61));
    expect(changeOf(p, "CAM3")).toMatchObject({ delta: -20, shares: 1_000 });
  });

  it("admin 18: temporada encerrada recusa a correção", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    await t.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, s.seasonId));
    expect(await domainCode(plan(s.seasonId, after(ROUND10_CLOSE, 60)))).toBe("season_closed");

    // na rota: com todas as temporadas encerradas, a mais nova é a encerrada
    const statuses = await t.db.select({ id: seasons.id, status: seasons.status }).from(seasons);
    await t.db.update(seasons).set({ status: "closed" });
    try {
      clock.set(after(ROUND10_CLOSE, 60));
      const token = await admin.tokenWith({ at: clock.now() });
      const res = await app.inject({ method: "GET", url: "/admin/payouts/corrections", headers: bearer(token) });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("season_closed");
    } finally {
      for (const row of statuses) {
        await t.db.update(seasons).set({ status: row.status }).where(eq(seasons.id, row.id));
      }
    }
    expect((await t.db.select().from(seasons).where(inArray(seasons.id, [s.seasonId])))[0]!.status).toBe("closed");
  });

  it("admin 31: jogador comum não acessa GET /admin/payouts/corrections", async () => {
    await newSeason();
    clock.set(new Date(TOKEN_T0.getTime() + 60_000));
    await expectAdminOnly(app, t.db, { method: "GET", url: "/admin/payouts/corrections" }, { okStatus: 200 });
  });
});
