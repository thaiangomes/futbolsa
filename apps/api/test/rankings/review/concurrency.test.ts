import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../../src/infra/clock/index.js";
import { lockSeason, lockWallets, withTransaction } from "../../../src/infra/db/index.js";
import { seasons, wallets } from "../../../src/infra/db/schema/index.js";
import { post } from "../../../src/modules/portfolio/ledger/index.js";
import { closeAtOfMonth } from "../../../src/modules/rankings/base.js";
import { CloseService } from "../../../src/modules/rankings/close.service.js";
import { processOneRecalc } from "../../../src/modules/rankings/recalc.js";
import { RecalcService } from "../../../src/modules/rankings/recalc.service.js";
import { currentHeads, currentRowsOf } from "../../../src/modules/rankings/snapshots.js";
import { useTestDatabase } from "../../support/db.js";
import { deferred, sleep } from "../../support/fixtures.js";
import { BASE, applyMovements, br, inTx, insertPayout, ipoBuy, player, portfolioSeason, setCash, type PortfolioSeason } from "../support.js";

// T10 (revisão): recálculo e fechamento ao mesmo tempo (duas transações), a tarefa de fechar rodando enquanto a F15
// encerra, e o encerramento num mês depois do fim da negociação.

const useSeason = () => {
  const database = useTestDatabase(8);
  const ctx = { database, s: undefined as unknown as PortfolioSeason, fla: 0, cor: 0, clock: new FixedClock(br("2027-04-06 12:00")) };
  beforeAll(async () => {
    ctx.s = await portfolioSeason(database.db);
    ctx.fla = ctx.s.clubIds.get("FLA3")!;
    ctx.cor = ctx.s.clubIds.get("COR3")!;
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, ctx.s.seasonId));
  });
  const rows = (key: string, period: "month" | "season" = "month") => inTx(database.db, (tx) => currentRowsOf(tx, ctx.s.seasonId, period, key));
  const heads = () => inTx(database.db, (tx) => currentHeads(tx, ctx.s.seasonId));
  return { ctx, rows, heads };
};

describe("recálculo de junho e fechamento de julho ao mesmo tempo", () => {
  const { ctx, rows, heads } = useSeason();

  it("julho não fica com a base velha de junho: o fechamento que perdeu o recálculo é refeito pelo pedido seguinte", async () => {
    const { database, s, cor, clock } = ctx;
    const db = database.db;
    const close = new CloseService(db, clock);
    const recalc = new RecalcService(db, clock);
    const ana = await player(db, s.seasonId);
    const bruno = await player(db, s.seasonId);
    await applyMovements(db, bruno.wallet, br("2027-04-05 11:00"), ipoBuy(cor, 1000, 4000));
    await setCash(db, ana.wallet, br("2027-06-10 12:00"), 10_800_000, ctx.fla);
    expect(await close.runOnce(br("2027-07-01 00:05"))).toEqual(["2027-04", "2027-05", "2027-06"]);
    await recalc.processRecalcRequests(br("2027-07-01 00:06")); // o que a própria tarefa possa ter pedido

    // 31/07 à noite: o placar da rodada de 30/06 chega atrasado (F12): o evento nasce e o pedido é gravado na mesma transação
    await insertPayout(db, { seasonId: s.seasonId, clubId: cor }, { key: "r18", perShare: 5000, closedAt: br("2027-06-30 20:00"), holdings: [[bruno.wallet, 1000]], createdAt: br("2027-07-31 23:58") });
    await inTx(db, (tx) => recalc.requestRecalc(tx, { seasonId: s.seasonId, from: br("2027-06-30 20:00"), reason: "pagamento" }));

    // o recálculo pega o pedido, grava junho v2 e ainda não fez COMMIT quando a tarefa fecha julho
    const wrote = deferred();
    const release = deferred();
    const recalcRun = withTransaction(
      db,
      async (tx) => {
        const out = await processOneRecalc(tx, br("2027-08-01 00:05"));
        wrote.resolve();
        await release.promise;
        return out;
      },
      { isolationLevel: "repeatable read" },
    );
    await wrote.promise;
    const closing = close.runOnce(br("2027-08-01 00:05"));
    await Promise.race([closing, sleep(800)]);
    release.resolve();
    expect((await recalcRun)!.versions).toEqual(["month:2027-06"]);
    expect(await closing).toEqual(["2027-07"]);

    // a passada seguinte do recálculo (a tarefa de cada minuto) acerta julho
    await recalc.processRecalcRequests(br("2027-08-01 00:06"));
    const june = (await rows("2027-06"))!;
    const july = (await rows("2027-07"))!;
    expect(june.get(bruno.wallet)!.equity).toBe(BASE + 5_000_000);
    expect(july.get(bruno.wallet)!.base).toBe(june.get(bruno.wallet)!.equity); // P2: a base é o oficial atual de junho
    expect(july.get(bruno.wallet)!.equity).toBe(BASE + 5_000_000);
    expect(await inTx(db, (tx) => recalc.pendingRecalc(tx, s.seasonId))).toBe(false);
    void heads;
  });
});

/** O encerramento da F15, como o plano dela descreve, numa transação: trava, fecha, zera, encerra. */
async function seasonClose(ctx: { database: { db: ReturnType<typeof useTestDatabase>["db"] }; s: PortfolioSeason; clock: FixedClock }, at: Date, hold?: { wrote: () => void; release: Promise<void> }) {
  const { db } = ctx.database;
  const close = new CloseService(db, ctx.clock);
  return withTransaction(db, async (tx) => {
    await lockSeason(tx, ctx.s.seasonId, "update");
    const ids = (await tx.db.select({ id: wallets.id }).from(wallets).where(eq(wallets.seasonId, ctx.s.seasonId))).map((w) => w.id);
    const locked = await lockWallets(tx, ids);
    const due = await close.closeMonthsDue(tx, ctx.s.seasonId, at);
    const result = await close.closeSeason(tx, { seasonId: ctx.s.seasonId, at });
    for (const w of locked) if (w.cash !== 0) await post(tx, { walletId: w.id, at, kind: "season_close", cashDelta: -w.cash });
    await tx.db.update(seasons).set({ status: "closed", closedAt: at }).where(eq(seasons.id, ctx.s.seasonId));
    hold?.wrote();
    if (hold) await hold.release;
    return { due, ...result };
  });
}

describe("a tarefa de fechar roda enquanto a F15 encerra", () => {
  const { ctx, rows, heads } = useSeason();

  it("encerramento às 23:59:40 de 31/12 com a negociação encerrada em 06/12: dezembro sai uma vez, às 23:59:00, com o patrimônio de antes de zerar", async () => {
    const { database, s, clock } = ctx;
    const db = database.db;
    const ana = await player(db, s.seasonId);
    await setCash(db, ana.wallet, br("2027-11-10 12:00"), 11_500_000, ctx.fla);
    await db.update(seasons).set({ status: "trading_ended", tradingEndedAt: br("2027-12-06 20:00") }).where(eq(seasons.id, s.seasonId));
    const job = new CloseService(db, clock);
    expect(await job.runOnce(br("2027-12-01 00:05"))).toEqual(["2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11"]);

    const wrote = deferred();
    const release = deferred();
    const C = br("2027-12-31 23:59:40");
    const closing = seasonClose(ctx, C, { wrote: wrote.resolve, release: release.promise });
    await wrote.promise;
    const jobRun = job.runOnce(br("2027-12-31 23:59:45")); // leu a temporada ainda `trading_ended`
    await Promise.race([jobRun, sleep(800)]);
    release.resolve();
    const result = await closing;
    expect(await jobRun).toEqual([]); // perdeu a corrida e conta como já feito
    expect(result).toMatchObject({ due: ["2027-12"], month: false, season: true });

    const dec = await database.db.execute(sql`select version, closed_at from futbolsa.ranking_snapshots where season_id = ${s.seasonId} and period_key = '2027-12'`);
    expect(dec.rows).toHaveLength(1);
    expect(new Date(dec.rows[0]!.closed_at as string).toISOString()).toBe(closeAtOfMonth("2027-12").toISOString());
    expect((await rows("2027-12"))!.get(ana.wallet)!.equity).toBe(11_500_000);
    expect((await rows("2027", "season"))!.get(ana.wallet)).toMatchObject({ base: BASE, equity: 11_500_000, position: 1 });
    expect((await heads()).filter((h) => h.period === "season")).toHaveLength(1);
  });
});

describe("negociação encerrada num mês e temporada encerrada no seguinte", () => {
  const { ctx, rows, heads } = useSeason();

  it("apito final em 30/11 às 22h e encerramento em 02/12: novembro sai às 23:59 de 30/11 e dezembro no encerramento", async () => {
    const { database, s, clock } = ctx;
    const db = database.db;
    const ana = await player(db, s.seasonId);
    await setCash(db, ana.wallet, br("2027-11-10 12:00"), 11_000_000, ctx.fla);
    await db.update(seasons).set({ status: "trading_ended", tradingEndedAt: br("2027-11-30 22:00") }).where(eq(seasons.id, s.seasonId));
    const job = new CloseService(db, clock);
    const byJob = await job.runOnce(br("2027-12-01 00:05"));
    expect(byJob).toContain("2027-11"); // o mês do apito ainda é um mês civil comum: fecha às 23:59 do último dia

    const result = await seasonClose(ctx, br("2027-12-02 10:00"));
    expect(result).toMatchObject({ due: [], month: true, season: true });
    const months = (await heads()).filter((h) => h.period === "month").map((h) => [h.periodKey, h.closedAt.toISOString()]);
    expect(months.slice(-2)).toEqual([
      ["2027-11", closeAtOfMonth("2027-11").toISOString()],
      ["2027-12", br("2027-12-02 10:00").toISOString()],
    ]);
    const dec = (await rows("2027-12"))!.get(ana.wallet)!;
    expect(dec.base).toBe((await rows("2027-11"))!.get(ana.wallet)!.equity);
  });
});

describe("as linhas season_close antes ou depois do cálculo", () => {
  const { ctx } = useSeason();

  it("zerar antes ou depois de closeSeason, na mesma transação, dá o mesmo ranking do mês e do ano", async () => {
    const { database, s } = ctx;
    const db = database.db;
    const people: Array<Awaited<ReturnType<typeof player>>> = [];
    for (let i = 0; i < 4; i++) people.push(await player(db, s.seasonId));
    await setCash(db, people[0]!.wallet, br("2027-11-10 12:00"), 12_000_000, ctx.fla);
    await setCash(db, people[1]!.wallet, br("2027-12-03 12:00"), 9_000_000, ctx.fla);
    await setCash(db, people[2]!.wallet, br("2027-12-03 12:00"), -25_000, ctx.fla);
    await db.update(seasons).set({ status: "trading_ended", tradingEndedAt: br("2027-12-06 20:00") }).where(eq(seasons.id, s.seasonId));
    const close = new CloseService(db, ctx.clock);
    await close.runOnce(br("2027-12-01 00:05"));
    const C = br("2027-12-10 18:00");

    const run = (order: "antes" | "depois") =>
      withTransaction(db, async (tx) => {
        await lockSeason(tx, s.seasonId, "update");
        const ids = (await tx.db.select({ id: wallets.id }).from(wallets).where(eq(wallets.seasonId, s.seasonId))).map((w) => w.id);
        const locked = await lockWallets(tx, ids);
        const zero = async () => {
          for (const w of locked) if (w.cash !== 0) await post(tx, { walletId: w.id, at: C, kind: "season_close", cashDelta: -w.cash });
        };
        if (order === "antes") await zero();
        await close.closeSeason(tx, { seasonId: s.seasonId, at: C });
        if (order === "depois") await zero();
        const month = await currentRowsOf(tx, s.seasonId, "month", "2027-12");
        const year = await currentRowsOf(tx, s.seasonId, "season", "2027");
        const snap = { month: [...month!.values()], year: [...year!.values()] };
        throw Object.assign(new Error("desfaz"), { snap });
      }).catch((e: { snap?: unknown }) => {
        if (!e.snap) throw e;
        return e.snap;
      });
    const before = await run("antes");
    const after = await run("depois");
    expect(before).toEqual(after);
    const year = (before as { year: Array<{ walletId: number; equity: number }> }).year;
    expect(year.find((r) => r.walletId === people[0]!.wallet)!.equity).toBe(12_000_000); // não zerou
    expect(year.find((r) => r.walletId === people[2]!.wallet)!.equity).toBe(-25_000);
  });
});
