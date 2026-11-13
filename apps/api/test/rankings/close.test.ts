import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasons } from "../../src/infra/db/schema/index.js";
import { closeAtOfMonth } from "../../src/modules/rankings/base.js";
import { CloseService } from "../../src/modules/rankings/close.service.js";
import { currentHeads, currentRowsOf } from "../../src/modules/rankings/snapshots.js";
import { useTestDatabase } from "../support/db.js";
import { BASE, bot, br, creditPayout, inTx, insertPayout, ipoBuy, applyMovements, setPrice, player, portfolioSeason, setBotsInRankings, setCash, type PortfolioSeason } from "./support.js";

// T5: fechar o mês e o ano (Rankings mensal e anual, critérios 2 a 7, 9, 11, 13, 15, 16, 19 e 20).

const useSeason = (poolSize = 8) => {
  const database = useTestDatabase(poolSize);
  const ctx = { database, s: undefined as unknown as PortfolioSeason, fla: 0, clock: new FixedClock(br("2027-04-06 12:00")), service: undefined as unknown as CloseService };
  beforeAll(async () => {
    ctx.s = await portfolioSeason(database.db);
    ctx.fla = ctx.s.clubIds.get("FLA3")!;
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, ctx.s.seasonId));
    ctx.service = new CloseService(database.db, ctx.clock);
  });
  const close = (key: string, at = closeAtOfMonth(key)) => inTx(database.db, (tx) => ctx.service.closeMonth(tx, { seasonId: ctx.s.seasonId, monthKey: key, at }));
  const rows = async (period: "month" | "season", key: string) => {
    const map = await inTx(database.db, (tx) => currentRowsOf(tx, ctx.s.seasonId, period, key));
    return map;
  };
  return { ctx, close, rows };
};

describe("fechamento do mês: junho com a chave dos bots ligada", () => {
  const { ctx, close, rows } = useSeason();

  it("rankings 2, 3, 4, 6, 13, 15 e 16", async () => {
    const { database, s, fla } = ctx;
    const ana = await player(database.db, s.seasonId);
    const carla = await player(database.db, s.seasonId);
    const bruno = await player(database.db, s.seasonId, { enteredAt: br("2027-06-20 10:00") });
    const nunca = await player(database.db, s.seasonId); // nunca negociou: 0,00% (critério 16)
    const falido = await player(database.db, s.seasonId);
    const robo = await bot(database.db, s.seasonId, "dividendos");
    await setBotsInRankings(database.db, s.seasonId, true);
    await setCash(database.db, ana.wallet, br("2027-05-10 12:00"), 11_200_000, fla);
    await setCash(database.db, falido.wallet, br("2027-05-10 12:00"), -25_000, fla);
    await close("2027-05");
    const may = (await rows("month", "2027-05"))!;
    expect(may.get(ana.wallet)).toMatchObject({ base: BASE, equity: 11_200_000, position: 1 });

    await setCash(database.db, ana.wallet, br("2027-06-10 12:00"), 12_096_000, fla); // +8,00% sobre R$ 112.000,00
    await setCash(database.db, carla.wallet, br("2027-06-10 12:00"), 10_500_000, fla);
    await setCash(database.db, robo.wallet, br("2027-06-10 12:00"), 10_500_000, fla); // empata com Carla (15)
    await setCash(database.db, bruno.wallet, br("2027-06-25 12:00"), 10_300_000, fla); // entrou em 20/06: +3,00%
    expect(await close("2027-06")).toBe(true);
    expect(await close("2027-06")).toBe(false); // repetir não grava segunda versão
    const june = (await rows("month", "2027-06"))!;
    expect(june.get(ana.wallet)).toMatchObject({ base: 11_200_000, equity: 12_096_000, position: 1 }); // 2: +800 pb
    expect(june.get(carla.wallet)!.position).toBe(2);
    expect(june.get(robo.wallet)!.position).toBe(2); // 6 e 15: o bot marcado empata com Carla
    expect(june.get(bruno.wallet)).toMatchObject({ base: BASE, position: 4 }); // 4: base de quem entrou depois
    expect(june.get(nunca.wallet)).toMatchObject({ base: BASE, equity: BASE }); // 16
    expect(june.get(falido.wallet)).toMatchObject({ base: -25_000, equity: -25_000 }); // sem base: P8
    expect(june.get(falido.wallet)!.position).toBe(june.size - 0); // o último, junto de quem também está sem base
    const heads = await inTx(database.db, (tx) => currentHeads(tx, s.seasonId));
    expect(heads.find((h) => h.periodKey === "2027-06")).toMatchObject({ version: 1, botsIncluded: true });
  });
});

describe("fechamento do mês: chave dos bots desligada", () => {
  const { ctx, close, rows } = useSeason();

  it("rankings 7: sem bot; 1º Ana, 2º Carla, 3º Bruno", async () => {
    const { database, s, fla } = ctx;
    const ana = await player(database.db, s.seasonId);
    const carla = await player(database.db, s.seasonId);
    const bruno = await player(database.db, s.seasonId);
    const robo = await bot(database.db, s.seasonId);
    await setCash(database.db, ana.wallet, br("2027-06-10 12:00"), 10_800_000, fla);
    await setCash(database.db, carla.wallet, br("2027-06-10 12:00"), 10_500_000, fla);
    await setCash(database.db, bruno.wallet, br("2027-06-10 12:00"), 10_300_000, fla);
    await close("2027-06");
    const june = (await rows("month", "2027-06"))!;
    expect([ana, carla, bruno].map((p) => june.get(p.wallet)!.position)).toEqual([1, 2, 3]);
    expect(june.has(robo.wallet)).toBe(false);
  });
});

describe("dividendo e negócio na virada do mês", () => {
  const { ctx, close, rows } = useSeason();

  it("rankings 9 e 11: o dividendo de 30/06 conta em junho e não de novo em julho; negócio às 00h01 não entra em junho", async () => {
    const { database, s } = ctx;
    const cor = s.clubIds.get("COR3")!;
    const ana = await player(database.db, s.seasonId);
    await applyMovements(database.db, ana.wallet, br("2027-04-05 11:00"), ipoBuy(cor, 1000, 4000));
    const ev = await insertPayout(database.db, { seasonId: s.seasonId, clubId: cor }, { key: "r18", perShare: 30, closedAt: br("2027-06-30 20:00"), status: "approved", holdings: [[ana.wallet, 1000]] });
    await setPrice(database.db, s, "COR3", br("2027-07-01 00:01"), 5000); // o preço sobe às 00h01 de 01/07: junho não o vê
    await creditPayout(database.db, ev, ana.wallet, cor, br("2027-07-01 00:30"), 30_000);
    await close("2027-06");
    await close("2027-07");
    const june = (await rows("month", "2027-06"))!.get(ana.wallet)!;
    const july = (await rows("month", "2027-07"))!.get(ana.wallet)!;
    expect(june.equity).toBe(BASE + 30_000); // R$ 300,00 a receber contam em junho
    expect(july.base).toBe(june.equity);
    expect(july.equity).toBe(june.equity + 1000 * 1000); // só o preço novo: o crédito de R$ 300,00 que caiu em julho não conta de novo
  });
});

describe("fechamento do ano", () => {
  const { ctx, close, rows } = useSeason();

  it("rankings 5, 19 e 20: o ano só fecha por closeSeason, com dezembro no mesmo instante; sem repetir", async () => {
    const { database, s, fla, service } = ctx;
    const ana = await player(database.db, s.seasonId);
    const bruno = await player(database.db, s.seasonId, { enteredAt: br("2027-06-20 10:00") });
    await setCash(database.db, ana.wallet, br("2027-08-10 12:00"), 11_000_000, fla);
    await setCash(database.db, bruno.wallet, br("2027-08-10 12:00"), 14_000_000, fla);
    const closedByJob = await service.runOnce(br("2028-01-05 12:00")); // 19: depois do fim do ano, a tarefa nunca fecha o ano
    expect(closedByJob).toContain("2027-12");
    expect(await rows("season", "2027")).toBeNull();
    const r = await inTx(database.db, (tx) => service.closeSeason(tx, { seasonId: s.seasonId, at: br("2027-12-31 23:59:30") }));
    expect(r).toEqual({ month: false, season: true }); // dezembro já fechado pela tarefa
    const year = (await rows("season", "2027"))!;
    expect(year.get(bruno.wallet)).toMatchObject({ base: BASE, equity: 14_000_000, position: 1 }); // 5: +40,00%
    expect(year.get(ana.wallet)).toMatchObject({ base: BASE, position: 2 });
    expect(await inTx(database.db, (tx) => service.closeSeason(tx, { seasonId: s.seasonId, at: br("2027-12-31 23:59") }))).toEqual({ month: false, season: false });
    void close;
  });
});

describe("fechamento do ano com o encerramento antes do fim do mês", () => {
  const { ctx, rows } = useSeason();

  it("rankings 20: encerrada em 10/12, dezembro e o ano saem no mesmo instante, e a tarefa não fecha dezembro depois", async () => {
    const { database, s, fla, service } = ctx;
    const ana = await player(database.db, s.seasonId);
    await setCash(database.db, ana.wallet, br("2027-12-05 12:00"), 11_000_000, fla);
    await database.db.update(seasons).set({ tradingEndedAt: br("2027-12-10 18:00") }).where(eq(seasons.id, s.seasonId));
    const r = await inTx(database.db, (tx) => service.closeSeason(tx, { seasonId: s.seasonId, at: br("2027-12-10 18:00") }));
    expect(r).toEqual({ month: true, season: true });
    expect((await rows("month", "2027-12"))!.get(ana.wallet)!.equity).toBe(11_000_000);
    const heads = await inTx(database.db, (tx) => currentHeads(tx, s.seasonId));
    expect(heads.filter((h) => h.closedAt.getTime() === br("2027-12-10 18:00").getTime()).map((h) => h.period).sort()).toEqual(["month", "season"]);
  });
});

describe("tarefa rankings-close", () => {
  const { ctx, rows } = useSeason();

  it("folga, API fora às 23h59 e API fora por meses: cada mês mede no próprio fechamento, em ordem, e só uma vez", async () => {
    const { database, s, fla, service } = ctx;
    const ana = await player(database.db, s.seasonId);
    await setCash(database.db, ana.wallet, br("2027-05-10 12:00"), 11_200_000, fla);
    await setCash(database.db, ana.wallet, br("2027-07-01 00:30"), 12_000_000, fla); // depois do fechamento de junho
    expect(await service.runOnce(br("2027-04-30 23:59:20"))).toEqual([]); // abril ainda não passou
    expect(await service.runOnce(br("2027-05-01 00:02"))).toEqual([]); // dentro da folga
    expect(await service.runOnce(br("2027-05-01 00:05"))).toEqual(["2027-04"]);
    // a API ficou fora até 02h de 01/07: maio e junho saem juntos, em ordem
    expect(await service.runOnce(br("2027-07-01 02:00"))).toEqual(["2027-05", "2027-06"]);
    expect(await service.runOnce(br("2027-07-01 02:30"))).toEqual([]);
    const may = (await rows("month", "2027-05"))!.get(ana.wallet)!;
    const june = (await rows("month", "2027-06"))!.get(ana.wallet)!;
    expect(may.equity).toBe(11_200_000);
    expect(june).toMatchObject({ base: 11_200_000, equity: 11_200_000 }); // o 12.000.000 de 00h30 de 01/07 não entra
    // duas execuções ao mesmo tempo gravam uma só
    const other = new CloseService(database.db, ctx.clock);
    const both = await Promise.all([service.runOnce(br("2027-08-01 02:00")), other.runOnce(br("2027-08-01 02:00"))]);
    expect(both.flat()).toEqual(["2027-07"]);
  });

  it("temporada encerrada: a tarefa pula; mês sem carteira grava ranking vazio", async () => {
    const { database, s, service } = ctx;
    const heads = await inTx(database.db, (tx) => currentHeads(tx, s.seasonId));
    expect(heads.map((h) => h.periodKey)).toContain("2027-04");
    await database.db.update(seasons).set({ status: "closed", closedAt: br("2027-09-01 00:00") }).where(eq(seasons.id, s.seasonId));
    expect(await service.runOnce(br("2027-12-31 12:00"))).toEqual([]);
  });
});
