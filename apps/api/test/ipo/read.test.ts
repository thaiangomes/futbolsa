import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipoOverviewSchema, ipoResultsSchema } from "@futbolsa/contracts";
import { ipoDates, placementPrice } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { ipoResults, seasonClubs, seasons } from "../../src/infra/db/schema/index.js";
import { IpoBidsService, IpoSettlementService } from "../../src/modules/ipo/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

const FIRST_KICKOFF = new Date("2027-04-11T19:00:00Z");
const DATES = ipoDates(FIRST_KICKOFF.getTime());
const DURING = TOKEN_T0;
const R = (reais: number) => reais * 100;

describe("leitura do IPO", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(DURING);
  let app: NestFastifyApplication;
  let bids: IpoBidsService;
  let settlement: IpoSettlementService;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let ana: TestAccount;
  let bruno: TestAccount;
  let carla: TestAccount;
  let semCarteira: TestAccount;
  let wallet: Record<string, number>;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    bids = app.get(IpoBidsService);
    settlement = app.get(IpoSettlementService);
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    // FLA3 (3º lugar, com R$ 10,55 de copas na faixa) e SAN3 (sem colocação: Clube dos Treze na B).
    await database.db.insert(seasonClubs).values([
      { seasonId, clubId: clubIds.get("FLA3")!, division: "A", prevPlacement: 3, bandCenter: 5055, bandFloor: 3033, bandCeiling: 7077 },
      { seasonId, clubId: clubIds.get("SAN3")!, division: "B", prevPlacement: null, bandCenter: 300, bandFloor: 180, bandCeiling: 420 },
    ]);
    ana = await createAccount(database.db, { nickname: "ana_leitura" });
    bruno = await createAccount(database.db, { nickname: "bruno_leitura" });
    carla = await createAccount(database.db, { nickname: "carla_leitura" });
    semCarteira = await createAccount(database.db, { nickname: "sem_carteira" });
    const ids = await openWallets(database.db, seasonId, [
      { type: "user", userId: ana.id },
      { type: "user", userId: bruno.id },
      { type: "user", userId: carla.id },
      { type: "treasury" },
    ]);
    wallet = { ana: ids[0]!, bruno: ids[1]!, carla: ids[2]! };
  });
  afterAll(() => app?.close());

  const get = async (account: TestAccount, url: string) =>
    app.inject({ method: "GET", url, headers: bearer(await account.tokenWith({ at: clock.now() })) });
  const setStatus = (status: string) => database.db.update(seasons).set({ status }).where(eq(seasons.id, seasonId));

  it("antes da abertura só vêm as datas previstas, sem faixa nem clubes, e o caixa de quem tem carteira", async () => {
    await database.db
      .update(seasons)
      .set({
        status: "preparing",
        offerSize: 3000,
        firstKickoff: FIRST_KICKOFF,
        ipoOpensAt: new Date(DATES.opensAt),
        ipoClosesAt: new Date(DATES.closesAt),
        tradingOpensAt: new Date(DATES.tradingOpensAt),
      })
      .where(eq(seasons.id, seasonId));
    const res = await get(ana, "/ipo");
    expect(res.statusCode).toBe(200);
    const body = ipoOverviewSchema.parse(res.json());
    expect(body).toMatchObject({
      status: "preparing",
      offerSize: 3000,
      opensAt: new Date(DATES.opensAt).toISOString(),
      closesAt: new Date(DATES.closesAt).toISOString(),
      tradingOpensAt: new Date(DATES.tradingOpensAt).toISOString(),
      clubs: [],
      cash: { total: R(100_000), reserved: 0, free: R(100_000) },
    });
    // quem não tem carteira na temporada não tem caixa
    expect(ipoOverviewSchema.parse((await get(semCarteira, "/ipo")).json()).cash).toBeNull();
  });

  it("com o IPO aberto: faixa com a conta das copas, minha oferta e o caixa total, reservado e livre", async () => {
    await setStatus("ipo_open");
    expect((await bids.place(wallet.ana!, "FLA3", { quantity: 1500, maxPrice: R(40), expect: "new" })).bid.reserved).toBe(R(60_000));

    const body = ipoOverviewSchema.parse((await get(ana, "/ipo")).json());
    expect(body.status).toBe("ipo_open");
    expect(body.clubs.map((c) => c.ticker)).toEqual(["FLA3", "SAN3"]);
    const fla = body.clubs[0]!;
    expect(fla.name).toBeTruthy();
    expect(fla.band).toEqual({ floor: 3033, center: 5055, ceiling: 7077, placementPrice: placementPrice(3), cupsPart: 5055 - placementPrice(3) });
    expect(fla.band.cupsPart).toBe(1055);
    expect(fla.myBid).toMatchObject({ quantity: 1500, maxPrice: R(40), reserved: R(60_000) });
    expect(body.clubs[1]!.band).toEqual({ floor: 180, center: 300, ceiling: 420, placementPrice: 300, cupsPart: 0 });
    expect(body.clubs[1]!.myBid).toBeNull();
    expect(body.cash).toEqual({ total: R(100_000), reserved: R(60_000), free: R(40_000) });
  });

  it("ipo 15: a resposta de um jogador não muda com as ofertas dos outros e não traz demanda nem nada deles", async () => {
    const before = (await get(ana, "/ipo")).json();
    await bids.place(wallet.bruno!, "FLA3", { quantity: 1000, maxPrice: R(38), expect: "new" });
    await bids.place(wallet.carla!, "FLA3", { quantity: 2000, maxPrice: R(35), expect: "new" });
    await bids.place(wallet.carla!, "SAN3", { quantity: 777, maxPrice: 400, expect: "new" });
    const res = await get(ana, "/ipo");
    // idêntica: nada das ofertas dos três outros entra na resposta
    expect(res.json()).toEqual(before);
    const text = res.body;
    for (const forbidden of ["demand", "bidCount", "bruno", "carla", "2000", "777"]) expect(text).not.toContain(forbidden);
    // o esquema é estrito: a resposta passa nele sem campos a mais
    expect(ipoOverviewSchema.safeParse(res.json()).success).toBe(true);
    // e cada um vê a própria oferta
    const brunoView = ipoOverviewSchema.parse((await get(bruno, "/ipo")).json());
    expect(brunoView.clubs[0]!.myBid).toMatchObject({ quantity: 1000, maxPrice: R(38) });
    expect(brunoView.cash).toEqual({ total: R(100_000), reserved: R(38_000), free: R(62_000) });
  });

  it("quem não tem carteira vê a faixa e nenhuma oferta nem caixa", async () => {
    const body = ipoOverviewSchema.parse((await get(semCarteira, "/ipo")).json());
    expect(body.clubs).toHaveLength(2);
    expect(body.clubs.every((c) => c.myBid === null)).toBe(true);
    expect(body.cash).toBeNull();
  });

  it("ipo 24: o resultado é pending com as ofertas abertas e settling no fechamento, antes de liquidar", async () => {
    expect(ipoResultsSchema.parse((await get(ana, "/ipo/results")).json())).toEqual({ status: "pending" });
    await setStatus("ipo_closed");
    expect(ipoResultsSchema.parse((await get(ana, "/ipo/results")).json())).toEqual({ status: "settling" });
    // fechado e ainda sem liquidar, a oferta de cada um segue ativa na visão do IPO
    const body = ipoOverviewSchema.parse((await get(ana, "/ipo")).json());
    expect(body.status).toBe("ipo_closed");
    expect(body.clubs[0]!.myBid).toMatchObject({ quantity: 1500 });
  });

  it("ipo 24: liquidado, traz por clube corte, demanda, fração, sobra, lote e as minhas ações", async () => {
    await settlement.settleDue(clock.now());
    const ana1 = ipoResultsSchema.parse((await get(ana, "/ipo/results")).json());
    expect(ana1.status).toBe("settled");
    if (ana1.status !== "settled") return;
    expect(ana1.clubs.map((c) => c.ticker)).toEqual(["FLA3", "SAN3"]);
    // FLA3: 1.500 até R$ 40, 1.000 até R$ 38 e 2.000 até R$ 35 para 3.000 ações → corte R$ 35, fração 2/3
    expect(ana1.clubs[0]).toMatchObject({
      cutPrice: R(35),
      demandAtCut: 4500,
      ratio: { num: 2, den: 3 },
      leftoverShares: 0,
      lotShares: 600,
      myAllocation: { shares: 1000, paid: R(35_000), refunded: R(25_000) },
    });
    // SAN3: só a oferta da Carla (777 até R$ 4,00) → corte no piso e sobra para a tesouraria
    expect(ana1.clubs[1]).toMatchObject({ cutPrice: 180, demandAtCut: 777, ratio: { num: 1, den: 1 }, leftoverShares: 2223, lotShares: 600, myAllocation: null });
    const carla1 = ipoResultsSchema.parse((await get(carla, "/ipo/results")).json());
    if (carla1.status !== "settled") throw new Error("esperava settled");
    expect(carla1.clubs[1]!.myAllocation).toEqual({ shares: 777, paid: 777 * 180, refunded: 777 * 400 - 777 * 180 });
    expect(carla1.clubs[0]!.myAllocation).toEqual({ shares: 1333, paid: 1333 * R(35), refunded: R(70_000) - 1333 * R(35) });
    // quem não ofertou vê o resultado dos clubes sem alocação nenhuma
    const sem = ipoResultsSchema.parse((await get(semCarteira, "/ipo/results")).json());
    expect(sem.status === "settled" && sem.clubs.every((c) => c.myAllocation === null)).toBe(true);
    // depois de liquidar, a oferta não prende mais caixa: o caixa reservado volta a zero
    const view = ipoOverviewSchema.parse((await get(ana, "/ipo")).json());
    expect(view.cash).toEqual({ total: R(100_000) - R(35_000), reserved: 0, free: R(65_000) });
    await assertLedgerConsistent(database.db, seasonId);
    await assertSharesConserved(database.db, seasonId);
  });

  it("ipo 24: com um clube sem resultado volta a settling, sem mostrar o parcial", async () => {
    const [saved] = await database.db.select().from(ipoResults).where(eq(ipoResults.clubId, clubIds.get("SAN3")!));
    await database.db.delete(ipoResults).where(eq(ipoResults.clubId, clubIds.get("SAN3")!));
    try {
      const res = await get(ana, "/ipo/results");
      expect(ipoResultsSchema.parse(res.json())).toEqual({ status: "settling" });
      expect(res.body).not.toContain("cutPrice");
    } finally {
      await database.db.insert(ipoResults).values(saved!);
    }
    expect(ipoResultsSchema.parse((await get(ana, "/ipo/results")).json()).status).toBe("settled");
  });

  it("sem login a leitura é recusada", async () => {
    expect((await app.inject({ method: "GET", url: "/ipo" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/ipo/results" })).statusCode).toBe(401);
  });
});
