import "reflect-metadata";
import { asc, eq } from "drizzle-orm";
import type { SchedulerRegistry } from "@nestjs/schedule";
import { beforeAll, describe, expect, it } from "vitest";
import type { Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { trades } from "../../src/infra/db/schema/index.js";
import { MarketJobs } from "../../src/infra/jobs/market-jobs.js";
import type { AdminEvents } from "../../src/modules/admin/events.js";
import { AdminLogService } from "../../src/modules/admin/log/index.js";
import { SuspensionService } from "../../src/modules/admin/suspension/suspension.service.js";
import {
  CancelService,
  CloseAuctionAdapter,
  CloseAuctionService,
  MarketPortImpl,
  OrderService,
  PostgresMatchingEngine,
  RefreshService,
  type AuctionClosed,
  type CloseAuctionResult,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { useTestDatabase } from "../support/db.js";
import { createUser } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  clubRow,
  giveShares,
  openPlayer,
  openTreasury,
  orderInputs,
  rejected,
  rolledBack,
  setTunnelState,
  syncTotalShares,
} from "./order-helpers.js";

// L7 do Plano do livro de ofertas e formador: o leilão na suspensão (Livro de ofertas e formador de mercado, critério
// 45; D5). A suspensão do clube ou do mercado para a contagem (o leilão fica só com o início); a retomada recomeça as
// 3 horas quando não sobra suspensão do clube nem do mercado. Parado, ninguém fecha o leilão: nem o fim do leilão nem a
// tarefa `auction-close`.

/** Um instante pelo relógio de Brasília. */
const brt = (time: string) => new Date(`2027-04-06T${time}:00-03:00`);
const TODAY = brt("00:00");
const T1240 = brt("12:40");
const T1540 = brt("15:40");
const TICKERS = ["FLA3", "PAL3"];
const RICH = 10_000_000;
const noFairValue = { compute: async (): Promise<Map<string, Cents>> => new Map() };
const quietAdminEvents = { marketSuspended() {}, marketResumed() {} } as unknown as AdminEvents;

function closed(result: CloseAuctionResult): AuctionClosed {
  if (!result.closed) throw new Error(`o leilão devia fechar e não fechou: ${result.reason}`);
  return result;
}

describe("o leilão na suspensão", () => {
  const t = useTestDatabase(5);
  const clock = new FixedClock(brt("10:00"));
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let closer: CloseAuctionService;
  let jobs: MarketJobs;
  let service: OrderService;
  let suspension: SuspensionService;
  let admin: string;
  let o: ReturnType<typeof orderInputs>;
  let cashBefore: number;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      clock.set(brt("10:00"));
      await openTreasury(db, seasonId, RICH);
      const ledger = new PortfolioLedger();
      closer = new CloseAuctionService(db, ledger);
      jobs = new MarketJobs({} as SchedulerRegistry, clock, closer);
      const adapter = new CloseAuctionAdapter(closer);
      service = new OrderService(db, new PostgresMatchingEngine(ledger), adapter);
      const cancels = new CancelService(db, ledger, adapter);
      const refresher = new RefreshService(db, service, cancels, noFairValue, clock, adapter);
      suspension = new SuspensionService(db, new AdminLogService(clock, db), new MarketPortImpl(cancels, refresher, clock), quietAdminEvents);
      admin = await createUser(db);
      o = orderInputs({ seasonId, now: brt("10:00") });
      await body();
      await assertMarketInvariants(db, seasonId, cashBefore);
    });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const row = () => clubRow(db, seasonId, club("FLA3"));
  const tradesOf = () => db.select().from(trades).where(eq(trades.clubId, club("FLA3"))).orderBy(asc(trades.id));
  const at = async (time: string) => clock.set(brt(time));

  /** O critério 39: Bruno vende 50 a R$ 43,00, Davi 100 a R$ 44,50, e a compra de Ana (100 a R$ 45,00) às 12h40 abre o leilão até 15h40. */
  const auctionUntil1540 = async () => {
    const bruno = await openPlayer(db, seasonId, RICH);
    await giveShares(db, bruno, club("FLA3"), 500);
    const davi = await openPlayer(db, seasonId, RICH);
    await giveShares(db, davi, club("FLA3"), 500);
    const ana = await openPlayer(db, seasonId, RICH);
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
    for (const ticker of TICKERS) await setTunnelState(db, seasonId, club(ticker), { lastPrice: 4000, tunnelRef: 4000, tunnelRefDay: TODAY });
    accepted(await service.place(o.sellLimit(bruno, "FLA3", 50, 4300, { now: brt("12:10") })));
    accepted(await service.place(o.sellLimit(davi, "FLA3", 100, 4450, { now: brt("12:20") })));
    const buy = accepted(await service.place(o.buyLimit(ana, "FLA3", 100, 4500, { now: T1240 })));
    expect(buy).toMatchObject({ openedAuction: true, auction: { until: T1540 }, trades: [] });
    return { ana, bruno };
  };

  /** Nada fecha o leilão parado: nem o fim dele nem a tarefa `auction-close`, a qualquer hora. */
  const nothingCloses = async (time: string) => {
    expect(await closer.closeAuction(seasonId, "FLA3", brt(time))).toMatchObject({ closed: false, reason: "paused" });
    await at(time);
    expect(await jobs.closeAuctions()).toEqual({ skipped: false, closed: [], unchanged: [], failed: [] });
    expect(await tradesOf()).toEqual([]);
  };

  it(
    "livro 45: com o FLA3 em leilão até 15h40, suspenso às 14h e retomado às 16h, o leilão recomeça às 16h e termina às 19h",
    scene(async () => {
      const { ana } = await auctionUntil1540();
      await at("14:00");
      await suspension.suspend(admin, { ticker: "FLA3", reason: "estádio interditado" });
      // parado: fica só o início do leilão
      expect(await row()).toMatchObject({ auctionOpenedAt: T1240, auctionUntil: null });
      await nothingCloses("15:40");
      await nothingCloses("15:59");
      expect(rejected(await service.place(o.buyLimit(ana, "FLA3", 1, 4400, { now: brt("15:00") }))).code).toBe("club_suspended");

      await at("16:00");
      await suspension.resume(admin, "FLA3");
      expect(await row()).toMatchObject({ auctionOpenedAt: T1240, auctionUntil: brt("19:00") });
      // às 18h59 ainda não acabou; às 19h fecha, com o horário do fechamento
      expect(await closer.closeAuction(seasonId, "FLA3", brt("18:59"))).toMatchObject({ closed: false, reason: "not_expired" });
      await at("18:00");
      expect((await jobs.closeAuctions()) as { closed: string[] }).toMatchObject({ closed: [] });
      expect(await tradesOf()).toEqual([]);
      const end = closed(await closer.closeAuction(seasonId, "FLA3", brt("19:00")));
      expect(end).toMatchObject({ price: 4450, volume: 100 });
      expect((await tradesOf()).map((x) => [x.quantity, x.inAuction, x.at])).toEqual([
        [50, true, brt("19:00")],
        [50, true, brt("19:00")],
      ]);
      expect(await row()).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });
    }),
  );

  it(
    "D5: o mercado todo suspenso também para a contagem, e a retomada do mercado recomeça as 3 horas",
    scene(async () => {
      await auctionUntil1540();
      await at("14:00");
      await suspension.suspend(admin, { reason: "falha na fonte dos placares" });
      expect(await row()).toMatchObject({ auctionOpenedAt: T1240, auctionUntil: null });
      await nothingCloses("16:30");
      await at("17:00");
      await suspension.resume(admin, undefined);
      expect(await row()).toMatchObject({ auctionUntil: brt("20:00") });
      // o PAL3 não estava em leilão e continua fora dele
      expect(await clubRow(db, seasonId, club("PAL3"))).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });
    }),
  );

  it(
    "D5: com o clube e o mercado suspensos, retomar só o mercado (ou só o clube) não recomeça o leilão; a última retomada recomeça",
    scene(async () => {
      await auctionUntil1540();
      await at("13:00");
      await suspension.suspend(admin, { ticker: "FLA3", reason: "estádio interditado" });
      await at("14:00");
      await suspension.suspend(admin, { reason: "falha na fonte dos placares" });
      await at("15:00");
      await suspension.resume(admin, undefined);
      expect(await row()).toMatchObject({ auctionOpenedAt: T1240, auctionUntil: null });
      await nothingCloses("16:00");

      // de novo o mercado suspenso; retomar o clube com o mercado ainda suspenso também não recomeça
      await suspension.suspend(admin, { reason: "falha outra vez" });
      await at("17:00");
      await suspension.resume(admin, "FLA3");
      expect(await row()).toMatchObject({ auctionUntil: null });
      await nothingCloses("18:00");
      await at("18:30");
      await suspension.resume(admin, undefined);
      expect(await row()).toMatchObject({ auctionOpenedAt: T1240, auctionUntil: brt("21:30") });
    }),
  );

  it(
    "o leilão já vencido não para na suspensão: nada fecha enquanto o clube está suspenso, e ele fecha na retomada sem ganhar 3 horas",
    scene(async () => {
      await auctionUntil1540();
      await at("15:41");
      await suspension.suspend(admin, { ticker: "FLA3", reason: "estádio interditado" });
      expect(await row()).toMatchObject({ auctionUntil: T1540 });
      expect(await closer.closeAuction(seasonId, "FLA3", brt("15:42"))).toMatchObject({ closed: false, reason: "club_suspended" });
      await at("15:43");
      expect(await jobs.closeAuctions()).toEqual({ skipped: false, closed: [], unchanged: ["FLA3"], failed: [] });
      await at("16:00");
      await suspension.resume(admin, "FLA3");
      expect(await row()).toMatchObject({ auctionUntil: T1540 });
      expect(await jobs.closeAuctions()).toMatchObject({ closed: ["FLA3"] });
      expect((await tradesOf()).map((x) => [x.quantity, x.at])).toEqual([
        [50, brt("16:00")],
        [50, brt("16:00")],
      ]);
    }),
  );
});
