import "reflect-metadata";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { marketRefreshRequests, matches, orders, seasonClubs, seasons } from "../../src/infra/db/schema/index.js";
import {
  CancelService,
  CloseAuctionAdapter,
  CloseAuctionService,
  FairValueService,
  OrderService,
  PostgresMatchingEngine,
  RefreshJob,
  RefreshService,
  RefreshWaker,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { useTestDatabase } from "../support/db.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import { assertMarketInvariants, clubRow, giveCash, giveShares, openPlayer, openTreasury, orderInputs, rolledBack, setTunnelState, syncTotalShares } from "./order-helpers.js";

// T11 do Plano do livro de ofertas e formador: a tarefa da reposição da casa (a agenda calculada, os pedidos e o despertar na hora).

const brt = (day: string, time: string) => new Date(`${day}T${time}-03:00`);
const TICKERS = ["FLA3", "PAL3", "SPT3"];
const RICH = 10_000_000;
const DAY = "2027-04-06";

describe("tarefa da reposição da casa", () => {
  const t = useTestDatabase(5);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let clock: FixedClock;
  let job: RefreshJob;
  let refresher: RefreshService;
  let orderService: OrderService;
  let waker: RefreshWaker;
  let fair: Map<string, Cents>;
  let cashBefore: number | undefined;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      treasury = await openTreasury(db, seasonId);
      const ledger = new PortfolioLedger();
      const adapter = new CloseAuctionAdapter(new CloseAuctionService(db, ledger));
      orderService = new OrderService(db, new PostgresMatchingEngine(ledger), adapter);
      const cancels = new CancelService(db, ledger, adapter);
      clock = new FixedClock(brt(DAY, "10:00"));
      waker = new RefreshWaker();
      fair = new Map(TICKERS.map((tk) => [tk, 4200]));
      const fairValues = { compute: async () => fair } as unknown as FairValueService;
      refresher = new RefreshService(db, orderService, cancels, fairValues, clock, adapter, undefined, waker);
      job = new RefreshJob(db, refresher, fairValues, waker, clock);
      await giveCash(db, treasury, RICH);
      for (const tk of TICKERS) await giveShares(db, treasury, clubIds.get(tk)!, 1000);
      for (const tk of TICKERS) await setTunnelState(db, seasonId, clubIds.get(tk)!, { lastPrice: 4200, tunnelRef: 4200, tunnelRefDay: brt(DAY, "00:00") });
      await syncTotalShares(db, seasonId);
      cashBefore = await totalCash(db, seasonId);
      await body();
      await assertMarketInvariants(db, seasonId, cashBefore);
    });

  const quotes = async (ticker: string) =>
    (
      await db
        .select({ side: orders.side, quantity: orders.quantity, filled: orders.filled, price: orders.limitPrice })
        .from(orders)
        .where(and(eq(orders.walletId, treasury), eq(orders.clubId, clubIds.get(ticker)!), eq(orders.status, "open")))
        .orderBy(asc(orders.side))
    ).map((r) => [r.side, r.quantity - r.filled, r.price]);
  const refreshedAt = async (ticker: string) => (await clubRow(db, seasonId, clubIds.get(ticker)!)).mmRefreshedAt;
  const setRefreshedAt = (ticker: string, at: Date | null) =>
    db.update(seasonClubs).set({ mmRefreshedAt: at }).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubIds.get(ticker)!)));
  const setAllRefreshedAt = (at: Date) => db.update(seasonClubs).set({ mmRefreshedAt: at }).where(eq(seasonClubs.seasonId, seasonId));

  it("livro 21 e 25: a primeira reposição é na estreia; a casa vendida às 10h05 só volta a vender às 12h00", scene(async () => {
    const first = await job.runDue(brt(DAY, "10:00"));
    expect(first.refreshed.sort()).toEqual(TICKERS);
    expect(await quotes("FLA3")).toEqual([["buy", 10, 3990], ["sell", 10, 4410]]);
    // Ana compra as 10 da venda da casa às 10h05
    const ana = await openPlayer(db, seasonId, RICH);
    cashBefore! += RICH; // a Ana entrou com R$ 100 mil depois da foto do caixa
    const bought = await orderService.place(orderInputs({ seasonId, now: brt(DAY, "10:05") }).buyLimit(ana, "FLA3", 10, 4410));
    expect(bought.ok).toBe(true);
    expect(await quotes("FLA3")).toEqual([["buy", 10, 3990]]);
    // 10h05 e 11h59: nada devido; o lado da venda fica vazio
    for (const time of ["10:05", "11:59"]) {
      const report = await job.runDue(brt(DAY, time));
      expect(report.refreshed, time).toEqual([]);
    }
    expect(await quotes("FLA3")).toEqual([["buy", 10, 3990]]);
    // às 12h00 em ponto a casa volta a vender
    const noon = await job.runDue(brt(DAY, "12:00"));
    expect(noon.refreshed).toContain("FLA3");
    expect(await quotes("FLA3")).toEqual([["buy", 10, 3990], ["sell", 10, 4410]]);
  }));

  it("API fora das 9h às 13h repõe uma vez ao voltar, não três; reiniciar às 11h não repõe antes das 12h", scene(async () => {
    await setAllRefreshedAt(brt(DAY, "09:00"));
    const back = await job.runDue(brt(DAY, "13:05"));
    expect(back.refreshed.sort()).toEqual(TICKERS);
    expect((await refreshedAt("FLA3"))!.getTime()).toBe(brt(DAY, "13:05").getTime());
    expect((await job.runDue(brt(DAY, "13:06"))).refreshed).toEqual([]);
    // reiniciar às 11h com a última reposição às 10h: nada
    await setAllRefreshedAt(brt(DAY, "10:00"));
    expect((await job.runDue(brt(DAY, "11:00"))).refreshed).toEqual([]);
    expect((await job.runDue(brt(DAY, "12:00"))).refreshed.length).toBe(3);
  }));

  it("livro 26: às 16h o jogo liga o modo de jogo (faixa de 14% e 3 por lado), às 18h00 continua, às 18h40 com o placar volta à faixa de 10%", scene(async () => {
    const [fla, pal] = [clubIds.get("FLA3")!, clubIds.get("PAL3")!];
    const [match] = await db
      .insert(matches)
      .values({ seasonId, competition: "brasileirao-a", round: 3, homeClubId: fla, awayClubId: pal, kickoff: brt(DAY, "16:00"), status: "scheduled" })
      .returning({ id: matches.id });
    await setAllRefreshedAt(brt(DAY, "15:00"));
    await job.runDue(brt(DAY, "15:59"));
    expect(await quotes("FLA3")).toEqual([]); // nada devido ainda: a casa não foi reposta (a de 15h já estava feita)
    await job.runDue(brt(DAY, "16:00"));
    expect(await quotes("FLA3")).toEqual([["buy", 3, 3906], ["sell", 3, 4494]]);
    expect(await quotes("SPT3")).toEqual([]); // SPT3 não joga: continua devendo só a agenda das 15h, que já foi
    await job.runDue(brt(DAY, "18:00"));
    expect(await quotes("FLA3")).toEqual([["buy", 3, 3906], ["sell", 3, 4494]]);
    // às 18h40 o placar entra: o jogo termina e o pedido de reposição repõe os dois clubes com a faixa de 10%
    await db.update(matches).set({ status: "finished", homeGoals: 2, awayGoals: 0, finishedAt: brt(DAY, "17:55") }).where(eq(matches.id, match!.id));
    await withTransaction(db, async (tx) => {
      await refresher.requestRefresh(tx, ["FLA3", "PAL3"], "score", { seasonId, at: brt(DAY, "18:40") });
    });
    const after = await job.runDue(brt(DAY, "18:40"));
    expect(after.refreshed.sort()).toEqual(["FLA3", "PAL3"]);
    expect(await quotes("FLA3")).toEqual([["buy", 10, 3990], ["sell", 10, 4410]]);
  }));

  it("livro 32 e P5: um pedido acorda a reposição na hora, sem esperar a passada do minuto, e o pedido atendido não é atendido de novo", scene(async () => {
    await setAllRefreshedAt(brt(DAY, "10:00"));
    job.onModuleInit();
    await withTransaction(db, async (tx) => {
      await refresher.requestRefresh(tx, ["PAL3"], "resume", { seasonId, at: brt(DAY, "10:30") });
    });
    // o despertar sai depois do COMMIT, sem esperar a passada do minuto
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await quotes("PAL3")).toEqual([["buy", 10, 3990], ["sell", 10, 4410]]);
    const pending = await db.select().from(marketRefreshRequests).where(and(eq(marketRefreshRequests.clubId, clubIds.get("PAL3")!)));
    expect(pending.every((r) => r.doneAt !== null)).toBe(true);
    // a passada do minuto não repõe de novo: o pedido está atendido e a agenda não manda
    clock.set(brt(DAY, "10:31"));
    expect((await job.runDue(brt(DAY, "10:31"))).refreshed).toEqual([]);
  }));

  it("clube suspenso não é reposto e o pedido continua aberto; o mercado todo suspenso e a negociação fechada também não repõem", scene(async () => {
    await setAllRefreshedAt(brt(DAY, "08:00"));
    await db.update(seasonClubs).set({ suspendedReason: "Placar errado" }).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubIds.get("SPT3")!)));
    const report = await job.runDue(brt(DAY, "10:00"));
    expect(report.refreshed.sort()).toEqual(["FLA3", "PAL3"]);
    expect(report.waiting).toEqual(["SPT3"]);
    expect(await refreshedAt("SPT3")).toEqual(brt(DAY, "08:00"));
    await db.update(seasons).set({ suspendedReason: "Manutenção" }).where(eq(seasons.id, seasonId));
    await setAllRefreshedAt(brt(DAY, "08:00"));
    expect((await job.runDue(brt(DAY, "10:00"))).refreshed).toEqual([]);
    await db.update(seasons).set({ suspendedReason: null, status: "ipo_closed" }).where(eq(seasons.id, seasonId));
    expect(await job.runDue(brt(DAY, "10:00"))).toMatchObject({ skipped: true, refreshed: [] });
    await db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, seasonId));
  }));

  it("sem o valor justo (calendário não importado) ninguém é reposto e a passada seguinte tenta de novo", scene(async () => {
    await setAllRefreshedAt(brt(DAY, "08:00"));
    const broken = new RefreshJob(db, undefined as never, { compute: async () => { throw new Error("sem jogos de brasileirao-a"); } } as unknown as FairValueService, waker, clock);
    const report = await broken.runDue(brt(DAY, "10:00"));
    expect(report.refreshed).toEqual([]);
    expect(report.failed.map((f) => f.ticker).sort()).toEqual(TICKERS);
    expect(report.failed[0]!.error).toMatch(/sem jogos/);
  }));

  it("um clube que falha não segura os outros", scene(async () => {
    await setAllRefreshedAt(brt(DAY, "08:00"));
    fair.delete("PAL3"); // sem valor justo de um clube: a reposição dele falha
    const report = await job.runDue(brt(DAY, "10:00"));
    expect(report.refreshed.sort()).toEqual(["FLA3", "SPT3"]);
    expect(report.failed.map((f) => f.ticker)).toEqual(["PAL3"]);
  }));

  it("duas passadas ao mesmo tempo: a segunda é pulada", scene(async () => {
    await setAllRefreshedAt(brt(DAY, "08:00"));
    const [a, b] = await Promise.all([job.runDue(brt(DAY, "10:00")), job.runDue(brt(DAY, "10:00"))]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
  }));
});
