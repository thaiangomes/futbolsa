import "reflect-metadata";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { ipoResults, orders, seasonClubs, seasons } from "../../src/infra/db/schema/index.js";
import { EventBus, type BusEvent } from "../../src/infra/realtime/index.js";
import { MemoryEventBus } from "../../src/infra/realtime/memory-bus.js";
import {
  CancelService,
  CloseAuctionAdapter,
  CloseAuctionService,
  FairValueService,
  OpeningJob,
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
import { assertMarketInvariants, clubRow, giveCash, giveShares, openPlayer, openTreasury, orderInputs, rolledBack, syncTotalShares } from "./order-helpers.js";

// T12 do Plano do livro de ofertas e formador: a abertura da negociação às 10h de Brasília do dia seguinte ao fechamento do IPO.

const brt = (day: string, time: string) => new Date(`${day}T${time}-03:00`);
const TICKERS = ["FLA3", "PAL3", "SPT3"];
const RICH = 10_000_000;

describe("abertura da negociação", () => {
  const t = useTestDatabase(5);
  let seasonId: number;
  let clubIds: Map<string, number>;
  let db: Database;
  let treasury: number;
  let clock: FixedClock;
  let bus: MemoryEventBus;
  let opening: OpeningJob;
  let orderService: OrderService;
  let cashBefore: number | undefined;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS, status: "ipo_closed", tradingOpensAt: brt("2027-04-05", "10:00") }));
  });

  /** Um jogador entra com R$ 100 mil: o caixa total do jogo cresce na mesma medida. */
  const player = async () => {
    const wallet = await openPlayer(db, seasonId, RICH);
    cashBefore! += RICH;
    return wallet;
  };
  const settle = async (tickers: string[], from: Database = db) => {
    await from.insert(ipoResults).values(
      tickers.map((tk) => ({ seasonId, clubId: clubIds.get(tk)!, cutPrice: 4000, demandAtCut: 3000, allocationNum: 1, allocationDen: 1, treasuryShares: 500, mmLotShares: 600, settledAt: brt("2027-04-04", "17:00") })),
    );
  };
  const wire = (database: Database) => {
    const ledger = new PortfolioLedger();
    const adapter = new CloseAuctionAdapter(new CloseAuctionService(database, ledger));
    const service = new OrderService(database, new PostgresMatchingEngine(ledger), adapter);
    const cancels = new CancelService(database, ledger, adapter);
    const fair = new Map<string, Cents>(TICKERS.map((tk) => [tk, 4000]));
    const fairValues = { compute: async () => fair } as unknown as FairValueService;
    const waker = new RefreshWaker();
    const refresher = new RefreshService(database, service, cancels, fairValues, clock, adapter, undefined, waker);
    const job = new RefreshJob(database, refresher, fairValues, waker, clock);
    return { service, opening: new OpeningJob(database, bus as unknown as EventBus, job, clock) };
  };

  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      clock = new FixedClock(brt("2027-04-05", "09:59"));
      bus = new MemoryEventBus(clock);
      ({ service: orderService, opening } = wire(db));
      treasury = await openTreasury(db, seasonId);
      await giveCash(db, treasury, RICH);
      for (const tk of TICKERS) await giveShares(db, treasury, clubIds.get(tk)!, 1100);
      await syncTotalShares(db, seasonId);
      cashBefore = await totalCash(db, seasonId);
      await body();
      await assertMarketInvariants(db, seasonId, cashBefore);
    });

  const events = () => {
    const got: BusEvent[] = [];
    bus.subscribe("season", (e) => got.push(e));
    return got;
  };
  const houseQuotes = async (ticker: string) =>
    (await db.select().from(orders).where(and(eq(orders.walletId, treasury), eq(orders.clubId, clubIds.get(ticker)!), eq(orders.status, "open")))).length;

  it("livro 21: às 9h59 a ordem é recusada e a negociação não abre; às 10h00 abre, a casa cota e a ordem é aceita ao preço de corte", scene(async () => {
    await settle(TICKERS);
    const ana = await player();
    const input = orderInputs({ seasonId, now: brt("2027-04-05", "09:59") });
    const early = await orderService.place(input.buyLimit(ana, "FLA3", 10, 4000));
    expect(early).toMatchObject({ ok: false, code: "market_closed" });
    expect(await opening.runOnce(brt("2027-04-05", "09:59"))).toEqual({ opened: false, reason: "not_due" });
    expect((await t.db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!.status).toBe("ipo_closed");

    clock.set(brt("2027-04-05", "10:00"));
    const result = await opening.runOnce(brt("2027-04-05", "10:00"));
    expect(result).toMatchObject({ opened: true });
    if (!result.opened) throw new Error("devia abrir");
    expect(result.refresh.refreshed.sort()).toEqual(TICKERS);
    // a casa já cota todos os clubes, e o preço exibido é o de corte
    for (const tk of TICKERS) expect(await houseQuotes(tk)).toBe(2);
    expect((await clubRow(db, seasonId, clubIds.get("FLA3")!)).lastPrice).toBe(4000);
    const accepted = await orderService.place(orderInputs({ seasonId, now: brt("2027-04-05", "10:00") }).buyLimit(ana, "FLA3", 5, 4200));
    expect(accepted.ok).toBe(true);
  }));

  it("liquidação atrasada adia a abertura até ela terminar", scene(async () => {
    await settle(["FLA3", "PAL3"]);
    const at = brt("2027-04-05", "10:05");
    clock.set(at);
    expect(await opening.runOnce(at)).toEqual({ opened: false, reason: "not_settled" });
    expect((await db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!.status).toBe("ipo_closed");
    await settle(["SPT3"]);
    expect(await opening.runOnce(at)).toMatchObject({ opened: true });
  }));

  it("rodar a tarefa duas vezes não repõe duas vezes, e o season.status sai uma vez só", scene(async () => {
    await settle(TICKERS);
    const got = events();
    clock.set(brt("2027-04-05", "10:00"));
    expect(await opening.runOnce(brt("2027-04-05", "10:00"))).toMatchObject({ opened: true });
    const refreshedAt = (await clubRow(db, seasonId, clubIds.get("FLA3")!)).mmRefreshedAt;
    expect(await opening.runOnce(brt("2027-04-05", "10:01"))).toEqual({ opened: false, reason: "not_closed" });
    expect((await clubRow(db, seasonId, clubIds.get("FLA3")!)).mmRefreshedAt).toEqual(refreshedAt);
    const status = got.map((e) => JSON.parse(e.frame) as { type: string; data: { status: string; tradingOpensAt: string } });
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ type: "season.status", data: { status: "trading", tradingOpensAt: "2027-04-05T13:00:00.000Z" } });
  }));

  it("sem temporada ou fora de ipo_closed não faz nada", scene(async () => {
    await settle(TICKERS);
    await db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, seasonId));
    expect(await opening.runOnce(brt("2027-04-05", "10:30"))).toEqual({ opened: false, reason: "not_closed" });
    await db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, seasonId));
    expect(await opening.runOnce(brt("2027-04-05", "10:30"))).toEqual({ opened: false, reason: "not_closed" });
    await db.update(seasons).set({ status: "ipo_closed" }).where(eq(seasons.id, seasonId));
  }));

  it("duas tarefas ao mesmo tempo abrem uma vez só", async () => {
    // fora da transação de teste: duas instâncias de verdade disputando a trava da temporada
    clock = new FixedClock(brt("2027-04-05", "10:00"));
    bus = new MemoryEventBus(clock);
    await t.db.update(seasons).set({ status: "ipo_closed" }).where(eq(seasons.id, seasonId));
    await t.db.delete(ipoResults).where(eq(ipoResults.seasonId, seasonId));
    await settle(TICKERS, t.db);
    const a = wire(t.db).opening;
    const b = wire(t.db).opening;
    const results = await Promise.all([a.runOnce(brt("2027-04-05", "10:00")), b.runOnce(brt("2027-04-05", "10:00"))]);
    expect(results.filter((r) => r.opened)).toHaveLength(1);
    expect((await t.db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!.status).toBe("trading");
    expect((await t.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, seasonId))).length).toBe(3);
  });
});
