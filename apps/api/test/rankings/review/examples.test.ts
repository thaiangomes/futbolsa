import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../../src/infra/clock/index.js";
import { payoutCredits, payoutEvents, seasons } from "../../../src/infra/db/schema/index.js";
import { closeAtOfMonth } from "../../../src/modules/rankings/base.js";
import { CloseService } from "../../../src/modules/rankings/close.service.js";
import { monthsDue } from "../../../src/modules/rankings/close.js";
import { RecalcService } from "../../../src/modules/rankings/recalc.service.js";
import { currentHeads, currentRowsOf } from "../../../src/modules/rankings/snapshots.js";
import { returnOf } from "../../../src/modules/rankings/view.js";
import { useTestDatabase } from "../../support/db.js";
import { BASE, applyMovements, br, creditPayout, inTx, insertPayout, ipoBuy, player, portfolioSeason, type PortfolioSeason } from "../support.js";

// T10 (revisão): os números das propostas P1 e P2 nos exemplos da especificação (critérios 9, 13, 24 e 25), a base ≤ 0
// dentro do recálculo (P8), o filtro `closed_at >= from` na borda, o instante gravado e o fuso do fechamento.

describe("fuso e instantes do fechamento (funções puras)", () => {
  it("o fechamento é 23:59:00 de Brasília (02:59 UTC do dia seguinte), inclusive na virada do ano", () => {
    expect(closeAtOfMonth("2027-06").toISOString()).toBe("2027-07-01T02:59:00.000Z");
    expect(closeAtOfMonth("2027-12").toISOString()).toBe("2028-01-01T02:59:00.000Z");
    expect(closeAtOfMonth("2028-02").toISOString()).toBe("2028-03-01T02:59:00.000Z"); // ano bissexto
  });

  it("o primeiro mês é o de `ipo_opens_at` em Brasília, e a tarefa só vê o mês depois do fechamento dele", () => {
    // 31/03 às 23h30 em Brasília já é 01/04 em UTC: o primeiro mês continua março
    const season = { ipoOpensAt: br("2027-03-31 23:30"), closedAt: null };
    expect(monthsDue(season, br("2027-03-31 23:58:59"))).toEqual([]);
    expect(monthsDue(season, br("2027-03-31 23:59"))).toEqual(["2027-03"]);
    expect(monthsDue({ ipoOpensAt: br("2027-04-01 00:30"), closedAt: null }, br("2027-05-01 00:00"))).toEqual(["2027-04"]);
    // temporada encerrada: nada depois do encerramento, nem que a tarefa rode meses depois
    expect(monthsDue({ ipoOpensAt: br("2027-04-01 10:00"), closedAt: br("2027-06-10 12:00") }, br("2027-12-01 00:00"))).toEqual(["2027-04", "2027-05"]);
    // encerramento depois das 23:59 do último dia: o mês já está vencido e fecha às 23:59
    expect(monthsDue({ ipoOpensAt: br("2027-04-01 10:00"), closedAt: br("2027-05-31 23:59:30") }, br("2027-12-01 00:00"))).toEqual(["2027-04", "2027-05"]);
  });
});

describe("P2 e critério 25: correção em setembro de um evento de 30/06", () => {
  const database = useTestDatabase(6);
  let s: PortfolioSeason;
  let close: CloseService;
  let recalc: RecalcService;
  const clock = new FixedClock(br("2027-09-05 11:00"));
  beforeAll(async () => {
    s = await portfolioSeason(database.db);
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, s.seasonId));
    close = new CloseService(database.db, clock);
    recalc = new RecalcService(database.db, clock);
  });
  const closeMonth = (key: string) => inTx(database.db, (tx) => close.closeMonth(tx, { seasonId: s.seasonId, monthKey: key, at: closeAtOfMonth(key) }));
  const rows = async (key: string) => (await inTx(database.db, (tx) => currentRowsOf(tx, s.seasonId, "month", key)))!;
  const versionOf = async (key: string) => (await inTx(database.db, (tx) => currentHeads(tx, s.seasonId))).find((h) => h.periodKey === key)?.version;

  it("junho, julho e agosto ganham versão nova com R$ 0,10; maio fica; o anual não existe; setembro fecha com a base nova", async () => {
    const db = database.db;
    const fla = s.clubIds.get("FLA3")!;
    const ana = await player(db, s.seasonId);
    const bruno = await player(db, s.seasonId); // não tem FLA3: não muda de patrimônio
    await applyMovements(db, ana.wallet, br("2027-04-05 11:00"), ipoBuy(fla, 1000, 4000));
    const v1 = await insertPayout(db, { seasonId: s.seasonId, clubId: fla }, { key: "r18", perShare: 30, closedAt: br("2027-06-30 20:00"), status: "approved", holdings: [[ana.wallet, 1000]] });
    await creditPayout(db, v1, ana.wallet, fla, br("2027-07-01 10:00"), 30_000); // aprovado em 01/07 (critério 9)
    for (const k of ["2027-05", "2027-06", "2027-07", "2027-08"]) await closeMonth(k);
    expect((await rows("2027-06")).get(ana.wallet)).toMatchObject({ base: BASE, equity: BASE + 30_000 }); // R$ 300,00 a receber em junho
    expect((await rows("2027-07")).get(ana.wallet)).toMatchObject({ base: BASE + 30_000, equity: BASE + 30_000 }); // 9: não conta de novo em julho

    // 05/09: o resultado é corrigido para R$ 0,10 por ação; o estorno de R$ 200,00 cai em setembro
    await db.update(payoutEvents).set({ status: "superseded" }).where(eq(payoutEvents.id, v1));
    const v2 = await insertPayout(db, { seasonId: s.seasonId, clubId: fla }, { key: "r18", perShare: 10, closedAt: br("2027-06-30 20:00"), status: "approved", version: 2, holdings: [[ana.wallet, 1000]], createdAt: br("2027-09-05 10:00") });
    const { entry } = await applyMovements(db, ana.wallet, br("2027-09-05 10:00"), { kind: "reversal", clubId: fla, cashDelta: -20_000, reason: "correção do resultado", ref: { type: "payout", id: v2 } });
    await db.insert(payoutCredits).values({ eventId: v2, walletId: ana.wallet, amount: -20_000, entryId: entry.id });
    await inTx(db, (tx) => recalc.requestRecalc(tx, { seasonId: s.seasonId, from: br("2027-06-30 20:00"), reason: "pagamento" }));
    const done = await recalc.processRecalcRequests(clock.now());
    expect(done).toEqual([{ seasonId: s.seasonId, versions: ["month:2027-06", "month:2027-07", "month:2027-08"] }]);

    expect(await versionOf("2027-05")).toBe(1);
    for (const k of ["2027-06", "2027-07", "2027-08"]) expect(await versionOf(k)).toBe(2);
    expect((await rows("2027-06")).get(ana.wallet)).toMatchObject({ base: BASE, equity: BASE + 10_000 });
    expect((await rows("2027-07")).get(ana.wallet)).toMatchObject({ base: BASE + 10_000, equity: BASE + 10_000 }); // caixa +300 e −200 a receber
    expect((await rows("2027-08")).get(ana.wallet)).toMatchObject({ base: BASE + 10_000, equity: BASE + 10_000 });
    expect((await rows("2027-06")).get(bruno.wallet)).toMatchObject({ base: BASE, equity: BASE });
    expect((await inTx(db, (tx) => currentHeads(tx, s.seasonId))).some((h) => h.period === "season")).toBe(false);

    // setembro fecha depois do estorno, com a base de agosto já corrigida (o estorno não conta como perda de setembro)
    await closeMonth("2027-09");
    expect((await rows("2027-09")).get(ana.wallet)).toMatchObject({ base: BASE + 10_000, equity: BASE + 10_000, position: 1 });
  });
});

describe("P8 no recálculo e a borda do filtro closed_at >= from", () => {
  const database = useTestDatabase(6);
  let s: PortfolioSeason;
  let close: CloseService;
  let recalc: RecalcService;
  const clock = new FixedClock(br("2027-09-05 11:00"));
  beforeAll(async () => {
    s = await portfolioSeason(database.db);
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, s.seasonId));
    close = new CloseService(database.db, clock);
    recalc = new RecalcService(database.db, clock);
  });
  const closeMonth = (key: string) => inTx(database.db, (tx) => close.closeMonth(tx, { seasonId: s.seasonId, monthKey: key, at: closeAtOfMonth(key) }));
  const rows = async (key: string) => (await inTx(database.db, (tx) => currentRowsOf(tx, s.seasonId, "month", key)))!;
  const request = (from: Date) => inTx(database.db, (tx) => recalc.requestRecalc(tx, { seasonId: s.seasonId, from, reason: "pagamento" }));

  it("critério 24 pelo recálculo: a correção deixa maio negativo; junho e julho ficam sem base, nas últimas posições, sem falhar", async () => {
    const db = database.db;
    const cor = s.clubIds.get("COR3")!;
    const carla = await player(db, s.seasonId);
    const ana = await player(db, s.seasonId);
    await applyMovements(db, carla.wallet, br("2027-04-05 11:00"), ipoBuy(cor, 1000, 4000));
    const v1 = await insertPayout(db, { seasonId: s.seasonId, clubId: cor }, { key: "r10", perShare: 10_000, closedAt: br("2027-05-20 20:00"), status: "approved", holdings: [[carla.wallet, 1000]] });
    await applyMovements(db, carla.wallet, br("2027-05-25 12:00"), { kind: "reversal", clubId: cor, cashDelta: -15_000_000, reason: "estorno" });
    await creditPayout(db, v1, carla.wallet, cor, br("2027-06-02 10:00"), 10_000_000);
    for (const k of ["2027-04", "2027-05", "2027-06", "2027-07"]) await closeMonth(k);
    expect((await rows("2027-05")).get(carla.wallet)!.equity).toBe(5_000_000); // −90.000 + 40.000 em ações + 100.000 a receber
    expect((await rows("2027-06")).get(carla.wallet)!.position).toBe(1);

    // a correção zera o valor por ação: maio passa a −R$ 50.000,00
    await db.update(payoutEvents).set({ status: "superseded" }).where(eq(payoutEvents.id, v1));
    await insertPayout(db, { seasonId: s.seasonId, clubId: cor }, { key: "r10", perShare: 0, closedAt: br("2027-05-20 20:00"), status: "pending", version: 2, holdings: [[carla.wallet, 1000]], createdAt: br("2027-09-05 10:00") });
    await request(br("2027-05-20 20:00"));
    const done = await recalc.processRecalcRequests(clock.now());
    expect(done[0]!.versions).toEqual(["month:2027-05", "month:2027-06", "month:2027-07"]);
    const may = (await rows("2027-05")).get(carla.wallet)!;
    expect(may.equity).toBe(-5_000_000);
    for (const k of ["2027-06", "2027-07"]) {
      const map = await rows(k);
      const row = map.get(carla.wallet)!;
      expect(row.base).toBe(-5_000_000);
      expect(row.position).toBe(map.size); // a última, depois de todos com base
      expect(returnOf(row.equity, row.base)).toBeNull();
      expect(map.get(ana.wallet)!.position).toBe(1);
    }
  });

  it("evento fechado exatamente às 23:59:00 entra em junho e o pedido com esse `from` refaz junho; 1 ms depois, só julho", async () => {
    const db = database.db;
    const fla = s.clubIds.get("FLA3")!;
    const bruno = await player(db, s.seasonId);
    await applyMovements(db, bruno.wallet, br("2027-04-05 11:00"), ipoBuy(fla, 100, 4000));
    // a carteira de Bruno é aberta depois dos fechamentos (com entered_at no começo): o oficial não a tem e o recálculo não a põe
    const june = closeAtOfMonth("2027-06");
    const members = await rows("2027-06");
    const someone = [...members.keys()][0]!;
    await insertPayout(db, { seasonId: s.seasonId, clubId: fla }, { key: "na-borda", perShare: 7, closedAt: june, holdings: [[someone, 1000]] });
    await request(june);
    expect((await recalc.processRecalcRequests(clock.now()))[0]!.versions).toEqual(["month:2027-06", "month:2027-07"]);
    const after = await rows("2027-06");
    expect(after.get(someone)!.equity).toBe(members.get(someone)!.equity + 7_000);
    expect(after.has(bruno.wallet)).toBe(false); // quem não estava no oficial continua fora

    const later = new Date(june.getTime() + 1);
    await insertPayout(db, { seasonId: s.seasonId, clubId: fla }, { key: "depois-da-borda", perShare: 11, closedAt: later, holdings: [[someone, 1000]] });
    const juneVersion = (await inTx(db, (tx) => currentHeads(tx, s.seasonId))).find((h) => h.periodKey === "2027-06")!.version;
    await request(later);
    expect((await recalc.processRecalcRequests(clock.now()))[0]!.versions).toEqual(["month:2027-07"]);
    expect((await inTx(db, (tx) => currentHeads(tx, s.seasonId))).find((h) => h.periodKey === "2027-06")!.version).toBe(juneVersion);
    const n = await db.execute(sql`select count(*)::int as n from futbolsa.ranking_recalc_requests where season_id = ${s.seasonId} and done_at is null`);
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  it("a tarefa grava closed_at = 23:59 do mês e created_at = agora, mesmo rodando dois dias depois", async () => {
    const db = database.db;
    const job = new CloseService(db, clock);
    expect(await job.runOnce(br("2027-09-02 15:00"))).toEqual(["2027-08"]);
    const [head] = (await db.execute(sql`select closed_at, created_at from futbolsa.ranking_snapshots where season_id = ${s.seasonId} and period_key = '2027-08'`)).rows;
    expect(new Date(head!.closed_at as string).toISOString()).toBe(closeAtOfMonth("2027-08").toISOString());
    expect(new Date(head!.created_at as string).toISOString()).toBe(br("2027-09-02 15:00").toISOString());
  });
});
