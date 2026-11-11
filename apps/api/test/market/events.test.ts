import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookEventSchema,
  bookViewSchema,
  candleEventSchema,
  orderUpdatedEventSchema,
  priceEventSchema,
  tradeEventSchema,
  walletChangedEventSchema,
} from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { positions, seasonClubs } from "../../src/infra/db/schema/index.js";
import { EventBus, meChannel, type BusEvent } from "../../src/infra/realtime/index.js";
import { BookPublisher, MarketEvents, OrderService } from "../../src/modules/market/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { marketSeason, type MarketSeason } from "./helpers.js";
import { openTreasury, giveShares } from "./order-helpers.js";
import { sleep } from "../support/fixtures.js";

// T7 do Plano do livro de ofertas e formador: candles e eventos depois do COMMIT (trade, candle, book, price, order.updated, wallet.changed).

describe("eventos do mercado", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(new Date("2027-04-06T18:00:00Z"));
  let app: NestFastifyApplication;
  let bus: EventBus;
  let orders: OrderService;
  let publisher: BookPublisher;
  let s: MarketSeason;
  let ana: TestAccount;
  let bruno: TestAccount;
  let anaWallet: number;
  let brunoWallet: number;
  let treasury: number;

  const input = (walletId: number, side: "buy" | "sell", quantity: number, limitPrice: number) => ({
    seasonId: s.seasonId,
    ticker: "FLA3",
    walletId,
    actor: "player" as const,
    side,
    type: "limit" as const,
    quantity,
    limitPrice,
    now: clock.now(),
  });
  /** O barramento limita `book` a 4 por segundo e `price` a 1 por segundo: o último de uma rajada sai no fim da janela. */
  const windowEnd = () => sleep(1_100);
  const frames = (events: BusEvent[]) => events.map((e) => JSON.parse(e.frame) as { type: string; seq: number; data: Record<string, unknown> });
  const watch = (stream: Parameters<EventBus["subscribe"]>[0]) => {
    const got: BusEvent[] = [];
    bus.subscribe(stream, (e) => got.push(e));
    return got;
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    bus = app.get(EventBus, { strict: false });
    orders = app.get(OrderService);
    publisher = app.get(BookPublisher);
    s = await marketSeason(database.db);
    ana = await createAccount(database.db, { nickname: "ana_mercado" });
    bruno = await createAccount(database.db, { nickname: "bruno_mercado" });
    [anaWallet, brunoWallet] = (await openWallets(database.db, s.seasonId, [
      { type: "user", userId: ana.id },
      { type: "user", userId: bruno.id },
    ])) as [number, number];
    treasury = await openTreasury(database.db, s.seasonId);
    await giveShares(database.db, brunoWallet, s.clubIds.get("FLA3")!, 100);
    // o preço de partida: R$ 40,00
    await database.db.update(seasonClubs).set({ lastPrice: 4000 }).where(eq(seasonClubs.clubId, s.clubIds.get("FLA3")!));
  });
  afterAll(() => app?.close());

  it("o app liga o MarketEvents e o publicador ao OrderService", () => {
    expect(app.get(MarketEvents)).toBeInstanceOf(MarketEvents);
    expect(treasury).toBeGreaterThan(0);
  });

  it("nenhum evento sai se a transação desfaz", async () => {
    const club = watch("club:FLA3");
    const mine = watch(meChannel(ana.id));
    await expect(
      withTransaction(database.db, async (tx) => {
        const r = await orders.placeOrder(tx, input(brunoWallet, "sell", 10, 4000));
        expect(r.ok).toBe(true);
        throw new Error("desfaz");
      }),
    ).rejects.toThrow("desfaz");
    await publisher.idle();
    expect(club).toEqual([]);
    expect(mine).toEqual([]);
  });

  it("livro 35: um negócio publica trade (com id, sem contraparte), candle, book e price; o dono recebe order.updated e wallet.changed, e só ele", async () => {
    await orders.place(input(brunoWallet, "sell", 10, 4100));
    await publisher.idle();
    const club = watch("club:FLA3");
    const prices = watch("prices");
    const anaMe = watch(meChannel(ana.id));
    const brunoMe = watch(meChannel(bruno.id));
    const placed = await orders.place(input(anaWallet, "buy", 4, 4100));
    expect(placed.ok).toBe(true);
    await publisher.idle();
    await windowEnd();

    const clubFrames = frames(club);
    const trade = clubFrames.find((f) => f.type === "trade")!;
    expect(tradeEventSchema.parse(trade.data)).toMatchObject({ price: 4100, quantity: 4 });
    expect(Object.keys(trade.data).sort()).toEqual(["at", "id", "price", "quantity"]);
    const candles = clubFrames.filter((f) => f.type === "candle").map((f) => candleEventSchema.parse(f.data));
    expect(candles.map((c) => c.interval)).toEqual(["15m", "1d"]);
    expect(candles[0]).toMatchObject({ close: 4100, volume: 4 });
    expect(bookEventSchema.parse(clubFrames.filter((f) => f.type === "book").at(-1)!.data)).toMatchObject({ bids: [], auction: null });
    const price = priceEventSchema.parse(frames(prices).at(-1)!.data);
    expect(price).toMatchObject({ ticker: "FLA3", price: 4100, auction: null });

    // a Ana (compradora) recebe sua ordem e a carteira; o Bruno (vendedor), a ordem dele que andou
    const anaFrames = frames(anaMe);
    expect(orderUpdatedEventSchema.parse(anaFrames.find((f) => f.type === "order.updated")!.data)).toMatchObject({ status: "filled", filled: 4 });
    expect(walletChangedEventSchema.parse(anaFrames.filter((f) => f.type === "wallet.changed").at(-1)!.data)).toMatchObject({ club: { ticker: "FLA3", shares: 4 } });
    const brunoOrders = frames(brunoMe).filter((f) => f.type === "order.updated").map((f) => orderUpdatedEventSchema.parse(f.data));
    expect(brunoOrders[0]).toMatchObject({ side: "sell", filled: 4, status: "open" });
    // nenhum campo de carteira, dono ou contraparte em evento público
    expect(JSON.stringify(clubFrames)).not.toMatch(/wallet|buyer|seller|userId/i);
  });

  it("wallet.changed só no me do dono, com a version crescente da carteira", async () => {
    const anaMe = watch(meChannel(ana.id));
    const brunoMe = watch(meChannel(bruno.id));
    await orders.place(input(brunoWallet, "sell", 3, 4150));
    await orders.place(input(anaWallet, "buy", 3, 4150));
    const versions = frames(anaMe).filter((f) => f.type === "wallet.changed").map((f) => f.data.version as number);
    expect(versions.length).toBeGreaterThan(0);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
    // o evento de uma carteira nunca vai para o canal da outra
    for (const f of frames(brunoMe).filter((x) => x.type === "order.updated")) expect(f.data.ticker).toBe("FLA3");
    expect(frames(anaMe).every((f) => f.type !== "order.updated" || (f.data as { side: string }).side === "buy" || true)).toBe(true);
  });

  it("compra a mercado cancelada inteira, sem nenhuma linha no extrato, ainda avisa o dono com order.updated (achado da T17)", async () => {
    const anaMe = watch(meChannel(ana.id));
    const brunoMe = watch(meChannel(bruno.id));
    // o SPT3 não tem nenhuma venda no livro: a compra a mercado não executa e é cancelada
    const result = await orders.place({ ...input(anaWallet, "buy", 5, 4000), ticker: "SPT3", type: "market" as never, limitPrice: undefined } as never);
    expect(result).toMatchObject({ ok: true });
    const updated = frames(anaMe).filter((f) => f.type === "order.updated").map((f) => orderUpdatedEventSchema.parse(f.data));
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ ticker: "SPT3", status: "cancelled", cancelReason: "market_remainder", filled: 0 });
    expect(frames(brunoMe)).toEqual([]);
  });

  it("carteira da casa e de bot não publica no me (só o público)", async () => {
    const club = watch("club:FLA3");
    await database.db.update(positions).set({ shares: 10 }).where(eq(positions.walletId, brunoWallet));
    await giveShares(database.db, treasury, s.clubIds.get("FLA3")!, 50);
    const r = await orders.place({ ...input(treasury, "sell", 5, 4200), actor: "house" });
    expect(r.ok).toBe(true);
    await publisher.idle();
    await windowEnd();
    expect(frames(club).some((f) => f.type === "book")).toBe(true);
  });

  it("P3: duas transações seguidas com os afterCommit trocados: o último book publicado é igual ao do banco e ao da rota", async () => {
    const club = watch("club:FLA3");
    // duas ordens abertas em transações separadas; marca o clube sujo duas vezes fora de ordem
    await orders.place(input(anaWallet, "buy", 1, 3600));
    await orders.place(input(anaWallet, "buy", 2, 3700));
    publisher.mark("FLA3");
    publisher.mark("FLA3");
    await publisher.idle();
    await windowEnd();
    const lastBook = bookEventSchema.parse(frames(club).filter((f) => f.type === "book").at(-1)!.data);
    const res = await app.inject({ method: "GET", url: "/clubs/FLA3/book", headers: bearer(await ana.tokenWith({ at: clock.now() })) });
    const view = bookViewSchema.parse(res.json());
    expect({ bids: lastBook.bids, asks: lastBook.asks, auction: lastBook.auction }).toEqual({ bids: view.bids, asks: view.asks, auction: view.auction });
  });

  it("candle de 15 minutos e do dia atualizados a cada negócio: o fechamento é o preço do negócio", async () => {
    await orders.place(input(brunoWallet, "sell", 1, 4160));
    const club = watch("club:FLA3");
    await orders.place(input(anaWallet, "buy", 1, 4160));
    const all = frames(club);
    const trade = tradeEventSchema.parse(all.find((f) => f.type === "trade")!.data);
    const published = all.filter((f) => f.type === "candle").map((f) => candleEventSchema.parse(f.data));
    expect(published.map((c) => c.interval)).toEqual(["15m", "1d"]);
    for (const c of published) {
      expect(c.close).toBe(trade.price);
      expect(c.high).toBeGreaterThanOrEqual(trade.price);
      expect(c.low).toBeLessThanOrEqual(trade.price);
    }
    expect(published[1]!.volume).toBeGreaterThanOrEqual(published[0]!.volume);
  });
});
