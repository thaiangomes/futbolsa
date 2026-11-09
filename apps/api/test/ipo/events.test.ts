import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entryAddedEventSchema, seasonStatusEventSchema, walletChangedEventSchema } from "@futbolsa/contracts";
import { ipoDates } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasonClubs, seasons } from "../../src/infra/db/schema/index.js";
import { EventBus, meChannel, type BusEvent } from "../../src/infra/realtime/index.js";
import { IpoBidsService, IpoClosingService, IpoSettlementService } from "../../src/modules/ipo/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets, seedSeason } from "../support/fixtures.js";

const FIRST_KICKOFF = new Date("2027-04-11T19:00:00Z");
const DATES = ipoDates(FIRST_KICKOFF.getTime());
const R = (reais: number) => reais * 100;

describe("eventos de tempo real do IPO", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(TOKEN_T0);
  let app: NestFastifyApplication;
  let bus: EventBus;
  let bids: IpoBidsService;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let ana: TestAccount;
  let bruno: TestAccount;
  let admin: TestAccount;
  let anaWallet: number;
  let brunoWallet: number;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    bus = app.get(EventBus, { strict: false });
    bids = app.get(IpoBidsService);
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    await database.db.insert(seasonClubs).values({ seasonId, clubId: clubIds.get("FLA3")!, division: "A", prevPlacement: 3, bandCenter: 5055, bandFloor: 3033, bandCeiling: 7077 });
    await database.db
      .update(seasons)
      .set({
        status: "ipo_open",
        offerSize: 1000,
        firstKickoff: FIRST_KICKOFF,
        ipoOpensAt: new Date(DATES.opensAt),
        ipoClosesAt: new Date(DATES.closesAt),
        tradingOpensAt: new Date(DATES.tradingOpensAt),
      })
      .where(eq(seasons.id, seasonId));
    ana = await createAccount(database.db, { nickname: "ana_eventos" });
    bruno = await createAccount(database.db, { nickname: "bruno_eventos" });
    admin = await createAccount(database.db, { role: "admin", nickname: "chefe_eventos" });
    [anaWallet, brunoWallet] = (await openWallets(database.db, seasonId, [
      { type: "user", userId: ana.id },
      { type: "user", userId: bruno.id },
      { type: "treasury" },
    ])) as [number, number, number];
  });
  afterAll(() => app?.close());

  const frames = (events: BusEvent[]) => events.map((e) => JSON.parse(e.frame) as { type: string; data: Record<string, unknown> });
  const watch = (stream: Parameters<EventBus["subscribe"]>[0]) => {
    const got: BusEvent[] = [];
    bus.subscribe(stream, (e) => got.push(e));
    return got;
  };

  it("uma oferta avisa o dono com wallet.changed e entry.added, e só ele", async () => {
    const mine = watch(meChannel(ana.id));
    const others = watch(meChannel(bruno.id));
    await bids.place(anaWallet, "FLA3", { quantity: 1500, maxPrice: R(40), expect: "new" });
    const f = frames(mine);
    expect(f.map((x) => x.type)).toEqual(["wallet.changed", "entry.added"]);
    expect(walletChangedEventSchema.parse(f[0]!.data)).toMatchObject({ cash: R(100_000), reserved: R(60_000), club: null });
    const entry = entryAddedEventSchema.parse(f[1]!.data);
    expect(entry).toMatchObject({ kind: "ipo_reserve", cashDelta: 0, reservedCashDelta: R(60_000), sharesDelta: 0, cashAfter: R(100_000) });
    // a versão é a contagem de linhas do extrato desta carteira (a linha `initial` e a desta oferta), a mesma nos dois eventos
    expect(entry.version).toBe(2);
    expect((f[0]!.data as { version: number }).version).toBe(2);
    expect(others).toEqual([]);
  });

  it("recusa, edição sem mudança e erro não publicam nada", async () => {
    const mine = watch(meChannel(ana.id));
    // além do caixa livre
    await expect(bids.place(anaWallet, "FLA3", { quantity: 100_000, maxPrice: R(40), expect: "existing" })).rejects.toMatchObject({ code: "insufficient_cash" });
    // o mesmo valor de antes: não grava, não avisa
    await bids.place(anaWallet, "FLA3", { quantity: 1500, maxPrice: R(40), expect: "existing" });
    // já existe
    await expect(bids.place(anaWallet, "FLA3", { quantity: 10, maxPrice: R(40), expect: "new" })).rejects.toMatchObject({ code: "bid_exists" });
    expect(mine).toEqual([]);
  });

  it("editar e cancelar avisam com o reservado novo", async () => {
    const mine = watch(meChannel(ana.id));
    await bids.place(anaWallet, "FLA3", { quantity: 1000, maxPrice: R(38), expect: "existing" });
    // operações de outro jogador no meio não mexem na sequência da Ana: a versão é por carteira
    await bids.place(brunoWallet, "FLA3", { quantity: 10, maxPrice: R(38), expect: "new" });
    await bids.place(brunoWallet, "FLA3", { quantity: 20, maxPrice: R(38), expect: "existing" });
    await bids.cancel(brunoWallet, "FLA3");
    await bids.cancel(anaWallet, "FLA3");
    const reserved = frames(mine)
      .filter((x) => x.type === "wallet.changed")
      .map((x) => (x.data as { reserved: number }).reserved);
    expect(reserved).toEqual([R(38_000), 0]);
    expect(frames(mine).filter((x) => x.type === "entry.added")).toHaveLength(2);
    // a oferta da Ana foi a 2ª linha; a edição e o cancelamento são a 3ª e a 4ª, sem salto por causa do Bruno
    expect(frames(mine).filter((x) => x.type === "wallet.changed").map((x) => (x.data as { version: number }).version)).toEqual([3, 4]);
    expect(frames(mine).filter((x) => x.type === "entry.added").map((x) => (x.data as { version: number }).version)).toEqual([3, 4]);
  });

  it("no fechamento, a temporada avisa no canal season, só quando fecha", async () => {
    const season = watch("season");
    const closing = app.get(IpoClosingService);
    await closing.closeIfDue(new Date(DATES.closesAt - 60_000));
    expect(season).toEqual([]);
    await closing.closeIfDue(new Date(DATES.closesAt));
    await closing.closeIfDue(new Date(DATES.closesAt + 60_000)); // repetida: nada de novo
    const f = frames(season);
    expect(f.map((x) => x.type)).toEqual(["season.status"]);
    expect(seasonStatusEventSchema.parse(f[0]!.data)).toEqual({
      seasonId,
      status: "ipo_closed",
      ipoClosesAt: new Date(DATES.closesAt).toISOString(),
      tradingOpensAt: new Date(DATES.tradingOpensAt).toISOString(),
    });
  });

  it("na liquidação cada ofertante recebe o caixa, as ações do clube e a linha do extrato", async () => {
    // reabre o período só para montar as ofertas, depois fecha de novo sem passar pelo evento
    await database.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, seasonId));
    await bids.place(anaWallet, "FLA3", { quantity: 1000, maxPrice: R(40), expect: "new" });
    await bids.place(brunoWallet, "FLA3", { quantity: 600, maxPrice: R(40), expect: "new" });
    await database.db.update(seasons).set({ status: "ipo_closed" }).where(eq(seasons.id, seasonId));

    const anaEvents = watch(meChannel(ana.id));
    const brunoEvents = watch(meChannel(bruno.id));
    await app.get(IpoSettlementService).settleDue(clock.now());

    // 1.600 de demanda a R$ 40 para 1.000 ações: corte R$ 40 e rateio de 5/8 (625 e 375 ações)
    for (const events of [anaEvents, brunoEvents]) {
      const f = frames(events);
      expect(f.map((x) => x.type)).toEqual(["wallet.changed", "entry.added"]);
      const changed = walletChangedEventSchema.parse(f[0]!.data);
      const entry = entryAddedEventSchema.parse(f[1]!.data);
      expect(changed.club?.ticker).toBe("FLA3");
      expect(changed.club!.shares).toBeGreaterThan(0);
      expect(changed.reserved).toBe(0);
      expect(entry).toMatchObject({ kind: "ipo_settle", ticker: "FLA3" });
      expect(entry.sharesDelta).toBe(changed.club!.shares);
      expect(entry.cashDelta).toBeLessThan(0);
    }
  });

  it("admin 20: adiar o fechamento avisa o canal season com as datas novas", async () => {
    await database.db
      .update(seasons)
      .set({ status: "ipo_open", ipoClosesAt: new Date(DATES.closesAt), tradingOpensAt: new Date(DATES.tradingOpensAt) })
      .where(eq(seasons.id, seasonId));
    const season = watch("season");
    const res = await app.inject({
      method: "PATCH",
      url: `/admin/seasons/${seasonId}`,
      headers: bearer(await admin.tokenWith({ at: clock.now() })),
      payload: { ipoClosesAt: "2027-04-06T19:00:00Z" },
    });
    expect(res.statusCode).toBe(200);
    const f = frames(season);
    expect(f.map((x) => x.type)).toEqual(["season.status"]);
    expect(f[0]!.data).toMatchObject({ status: "ipo_open", ipoClosesAt: "2027-04-06T19:00:00.000Z", tradingOpensAt: "2027-04-07T13:00:00.000Z" });
    // antecipar é recusado e não avisa
    const early = await app.inject({
      method: "PATCH",
      url: `/admin/seasons/${seasonId}`,
      headers: bearer(await admin.tokenWith({ at: clock.now() })),
      payload: { ipoClosesAt: "2027-04-02T19:00:00Z" },
    });
    expect(early.statusCode).toBe(422);
    expect(frames(season)).toHaveLength(1);
  });
});
