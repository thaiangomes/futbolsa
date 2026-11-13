import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { payoutEvents, rankingSnapshots, seasons } from "../../src/infra/db/schema/index.js";
import { closeAtOfMonth } from "../../src/modules/rankings/base.js";
import { CloseService } from "../../src/modules/rankings/close.service.js";
import { RecalcService } from "../../src/modules/rankings/recalc.service.js";
import { currentRowsOf, currentSnapshot, rowsOfSnapshot } from "../../src/modules/rankings/snapshots.js";
import { useTestDatabase } from "../support/db.js";
import { BASE, applyMovements, br, inTx, insertPayout, ipoBuy, player, portfolioSeason, setCash, type PortfolioSeason } from "./support.js";

// T6: recálculo dos rankings já fechados (Rankings mensal e anual 10 e 23; Admin 16 e 36).

const useRecalc = () => {
  const database = useTestDatabase(8);
  const ctx = { database, s: undefined as unknown as PortfolioSeason, fla: 0, cor: 0, close: undefined as unknown as CloseService, recalc: undefined as unknown as RecalcService };
  beforeAll(async () => {
    ctx.s = await portfolioSeason(database.db);
    ctx.fla = ctx.s.clubIds.get("FLA3")!;
    ctx.cor = ctx.s.clubIds.get("COR3")!;
    const clock = new FixedClock(br("2027-10-01 12:00"));
    ctx.close = new CloseService(database.db, clock);
    ctx.recalc = new RecalcService(database.db, clock);
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, ctx.s.seasonId));
  });
  const closeMonth = (key: string) => inTx(database.db, (tx) => ctx.close.closeMonth(tx, { seasonId: ctx.s.seasonId, monthKey: key, at: closeAtOfMonth(key) }));
  const request = (from: Date, reason = "pagamento") => inTx(database.db, (tx) => ctx.recalc.requestRecalc(tx, { seasonId: ctx.s.seasonId, from, reason }));
  const rows = (key: string, period: "month" | "season" = "month") => inTx(database.db, async (tx) => (await currentRowsOf(tx, ctx.s.seasonId, period, key))!);
  const version = (key: string) => inTx(database.db, async (tx) => (await currentSnapshot(tx, ctx.s.seasonId, "month", key))!.version);
  return { ctx, closeMonth, request, rows, version };
};

describe("recálculo: um pagamento que nasce depois do fechamento", () => {
  const { ctx, closeMonth, request, rows, version } = useRecalc();

  it("rankings 10 e Admin 16/36: junho passa a mostrar Bruno em 1º na versão 2; a versão 1 continua gravada; aprovar sem mudar nada não grava versão", async () => {
    const { database, s, fla, cor } = ctx;
    const ana = await player(database.db, s.seasonId);
    const bruno = await player(database.db, s.seasonId);
    const carla = await player(database.db, s.seasonId);
    await applyMovements(database.db, bruno.wallet, br("2027-04-05 11:00"), ipoBuy(cor, 1000, 4000));
    await setCash(database.db, ana.wallet, br("2027-06-10 12:00"), 10_800_000, fla);
    await closeMonth("2027-06");
    expect((await rows("2027-06")).get(ana.wallet)!.position).toBe(1);

    // a rodada 18 fechou às 20h de 30/06, o placar só foi importado em 01/07: o evento nasce atrasado
    const ev = await insertPayout(database.db, { seasonId: s.seasonId, clubId: cor }, { key: "r18", perShare: 5000, closedAt: br("2027-06-30 20:00"), holdings: [[bruno.wallet, 1000]] });
    await request(br("2027-06-30 20:00"));
    expect(await inTx(database.db, (tx) => ctx.recalc.pendingRecalc(tx, s.seasonId))).toBe(true);
    const done = await ctx.recalc.processRecalcRequests(br("2027-07-01 09:00"));
    expect(done).toEqual([{ seasonId: s.seasonId, versions: ["month:2027-06"] }]);
    expect(await inTx(database.db, (tx) => ctx.recalc.pendingRecalc(tx, s.seasonId))).toBe(false);

    const june = await rows("2027-06");
    expect(june.get(bruno.wallet)).toMatchObject({ position: 1, equity: BASE + 5_000_000 });
    expect(june.get(ana.wallet)!.position).toBe(2);
    expect(await version("2027-06")).toBe(2);
    const [v1] = await database.db.select().from(rankingSnapshots).where(sql`period_key = '2027-06' and version = 1 and season_id = ${s.seasonId}`);
    const old = await inTx(database.db, (tx) => rowsOfSnapshot(tx, v1!.id));
    expect(old.find((r) => r.walletId === ana.wallet)!.position).toBe(1); // a versão 1 continua como era
    const v2 = await inTx(database.db, async (tx) => (await currentSnapshot(tx, s.seasonId, "month", "2027-06"))!);
    expect(v2.version).toBe(2);
    const [v2row] = await database.db.select().from(rankingSnapshots).where(eq(rankingSnapshots.id, v2.id));
    expect(v2row!.reason).toBe("pagamento");

    // rankings 23 e Admin 36: aprovar não muda o patrimônio, então nada de versão nova
    await database.db.update(payoutEvents).set({ status: "approved" }).where(eq(payoutEvents.id, ev));
    await request(br("2027-06-30 20:00"));
    expect(await ctx.recalc.processRecalcRequests(br("2027-07-02 09:00"))).toEqual([{ seasonId: s.seasonId, versions: [] }]);
    expect(await version("2027-06")).toBe(2);
    void carla;
  });
});

describe("recálculo: cascata, conjunto de participantes e pedidos", () => {
  const { ctx, closeMonth, request, rows, version } = useRecalc();

  it("cascata: um evento de 30/06 refaz junho, julho e agosto; o conjunto de quem estava no oficial não muda", async () => {
    const { database, s, fla, cor } = ctx;
    const ana = await player(database.db, s.seasonId);
    const bruno = await player(database.db, s.seasonId);
    const gone = await player(database.db, s.seasonId);
    await applyMovements(database.db, bruno.wallet, br("2027-04-05 11:00"), ipoBuy(cor, 1000, 4000));
    await setCash(database.db, ana.wallet, br("2027-06-10 12:00"), 10_800_000, fla);
    for (const k of ["2027-06", "2027-07", "2027-08"]) await closeMonth(k);
    const julyBefore = (await rows("2027-07")).get(bruno.wallet)!;
    // depois dos fechamentos: Bruno é bloqueado, outra conta é excluída
    await database.db.execute(sql`update futbolsa.users set status = 'blocked' where id = ${bruno.account.id}`);
    await database.db.execute(sql`update futbolsa.users set status = 'deleted', nickname = null, email = null where id = ${gone.account.id}`);

    await insertPayout(database.db, { seasonId: s.seasonId, clubId: cor }, { key: "r18", perShare: 5000, closedAt: br("2027-06-30 20:00"), status: "approved", holdings: [[bruno.wallet, 1000]] });
    await request(br("2027-06-30 20:00"), "pagamento");
    await request(br("2027-06-30 20:00"), "pagamento"); // dois pedidos seguidos viram um
    const [{ n }] = (await database.db.execute(sql`select count(*)::int as n from futbolsa.ranking_recalc_requests where done_at is null`)).rows as [{ n: number }];
    expect(n).toBe(1);
    const done = await ctx.recalc.processRecalcRequests(br("2027-09-05 09:00"));
    expect(done[0]!.versions).toEqual(["month:2027-06", "month:2027-07", "month:2027-08"]);
    expect(await version("2027-06")).toBe(2);
    expect(await version("2027-07")).toBe(2);
    const julyAfter = (await rows("2027-07")).get(bruno.wallet)!;
    expect(julyAfter.base).toBe(BASE + 5_000_000); // a base de julho é o patrimônio novo de junho
    expect(julyAfter.equity).toBe(julyBefore.equity + 5_000_000);
    // o conjunto não muda: Bruno (bloqueado hoje) continua nas três versões e a conta excluída também
    for (const k of ["2027-06", "2027-07", "2027-08"]) {
      const map = await rows(k);
      expect(map.has(bruno.wallet)).toBe(true);
      expect(map.has(gone.wallet)).toBe(true);
    }
  });

  it("um pedido com `from` anterior prevalece, e o pedido da temporada encerrada é fechado sem escrever", async () => {
    const { database, s } = ctx;
    await request(br("2027-08-31 12:00"), "pagamento");
    await request(br("2027-06-30 12:00"), "anulação");
    const [open] = (await database.db.execute(sql`select from_at, reason from futbolsa.ranking_recalc_requests where done_at is null`)).rows as Array<{ from_at: string; reason: string }>;
    expect(new Date(open!.from_at).toISOString()).toBe(br("2027-06-30 12:00").toISOString());
    expect(open!.reason).toBe("pagamento; anulação");
    const before = await version("2027-06");
    await database.db.update(seasons).set({ status: "closed", closedAt: br("2027-12-31 12:00") }).where(eq(seasons.id, s.seasonId));
    expect(await ctx.recalc.processRecalcRequests(br("2028-01-02 09:00"))).toEqual([{ seasonId: s.seasonId, versions: [] }]);
    expect(await version("2027-06")).toBe(before);
    expect(await inTx(database.db, (tx) => ctx.recalc.pendingRecalc(tx, s.seasonId))).toBe(false);
  });
});
