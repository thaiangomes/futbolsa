import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MarkersResponse, type MyTradesResponse, markersResponseSchema, myTradesResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { matches, payoutEvents } from "../../src/infra/db/schema/index.js";
import { gameMarkers } from "../../src/modules/portfolio/markers/games.js";
import { myTrades } from "../../src/modules/portfolio/markers/my-trades.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { insertMatch } from "../market/helpers.js";
import { AFTER_OPEN, applyMovements, insertPayout, ipoBuy, portfolioSeason, tradeBuy, tradeSell, type PortfolioSeason } from "./support.js";

// T8: marcadores de jogos, dividendos e meus negócios (Carteira e gráficos 24 a 28, 42 e 43).

const at = (iso: string) => new Date(iso);

describe("construtores puros", () => {
  const base = { competition: "brasileirao-a", round: 5, phase: null, homeClubId: 1, awayClubId: 2, advancedClubId: null, opponent: { ticker: "PAL3", name: "Palmeiras" } };
  const now = at("2027-04-06T18:00:00Z");

  it("carteira 24: V pelo placar do clube em casa e D do lado do adversário", () => {
    const game = { ...base, kickoff: at("2027-04-04T20:00:00Z"), status: "finished", homeGoals: 2, awayGoals: 1 };
    expect(gameMarkers(1, [game], now)[0]).toMatchObject({ result: "V", goalsFor: 2, goalsAgainst: 1, home: true, status: "finished" });
    expect(gameMarkers(2, [game], now)[0]).toMatchObject({ result: "D", goalsFor: 1, goalsAgainst: 2, home: false });
  });

  it("carteira 25: jogo com início já passado e sem fim aparece como em andamento, sem placar; adiado e cancelado ficam de fora; jogo futuro também", () => {
    const live = { ...base, kickoff: at("2027-04-06T17:00:00Z"), status: "scheduled", homeGoals: null, awayGoals: null };
    expect(gameMarkers(1, [live], now)[0]).toMatchObject({ status: "live", goalsFor: null, result: null });
    const others = ["postponed", "cancelled"].map((status) => ({ ...base, kickoff: at("2027-04-03T20:00:00Z"), status, homeGoals: null, awayGoals: null }));
    const future = { ...base, kickoff: at("2027-04-09T20:00:00Z"), status: "scheduled", homeGoals: null, awayGoals: null };
    expect(gameMarkers(1, [...others, future], now)).toEqual([]);
  });

  it("carteira 42: decidido nos pênaltis mostra o placar, E e se classificou ou foi eliminado", () => {
    const game = { ...base, competition: "copa-do-brasil", phase: "oitavas", kickoff: at("2027-04-04T20:00:00Z"), status: "finished", homeGoals: 1, awayGoals: 1, advancedClubId: 2 };
    expect(gameMarkers(1, [game], now)[0]).toMatchObject({ result: "E", advanced: false });
    expect(gameMarkers(2, [game], now)[0]).toMatchObject({ result: "E", advanced: true });
  });

  it("carteira 27: a alocação do IPO sai na abertura da negociação, e o ajuste do admin não é negócio", () => {
    const opens = at("2027-04-05T13:00:00Z");
    const rows = [
      { at: at("2027-04-04T20:00:00Z"), kind: "ipo_settle", sharesDelta: 1000, cashDelta: -3_500_000, price: 3500 },
      { at: at("2027-04-06T16:00:00Z"), kind: "trade", sharesDelta: -300, cashDelta: 1_350_000, price: 4500 },
      { at: at("2027-04-06T17:00:00Z"), kind: "adjustment", sharesDelta: 50, cashDelta: 0, price: 4500 },
    ];
    expect(myTrades(rows, opens)).toEqual([
      { at: opens.toISOString(), side: "buy", quantity: 1000, price: 3500 },
      { at: "2027-04-06T16:00:00.000Z", side: "sell", quantity: 300, price: 4500 },
    ]);
  });
});

describe("rotas dos marcadores", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let fla: number;
  let pal: number;

  const player = async () => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    return { account, wallet: wallet! };
  };
  const markers = async (range = "7d", ticker = "FLA3"): Promise<MarkersResponse> => {
    const res = await app.inject({ method: "GET", url: `/clubs/${ticker}/markers?range=${range}` });
    expect(res.statusCode).toBe(200);
    return markersResponseSchema.parse(res.json());
  };
  const mine = async (account: TestAccount, range = "7d", ticker = "FLA3"): Promise<MyTradesResponse> => {
    const res = await app.inject({ method: "GET", url: `/portfolio/clubs/${ticker}/trades?range=${range}`, headers: bearer(await account.tokenWith({ at: clock.now() })) });
    expect(res.statusCode).toBe(200);
    return myTradesResponseSchema.parse(res.json());
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    pal = s.clubIds.get("PAL3")!;
  });
  afterAll(async () => {
    await app.close();
  });

  it("jogos: rodada 5 com V e D, em andamento, adiado só na data disputada, cancelado fora, adversário não listado sem ticker", async () => {
    const [unlisted] = [...s.clubIds.entries()].filter(([t]) => !["FLA3", "PAL3", "SPT3", "COR3"].includes(t)).map(([, id]) => id);
    const finished = await insertMatch(database.db, { seasonId: s.seasonId, homeClubId: fla, awayClubId: pal, kickoff: at("2027-04-05T20:00:00Z"), status: "finished", round: 5 });
    await database.db.update(matches).set({ homeGoals: 2, awayGoals: 1, finishedAt: at("2027-04-04T22:00:00Z") }).where(eq(matches.id, finished));
    await insertMatch(database.db, { seasonId: s.seasonId, homeClubId: unlisted!, awayClubId: fla, kickoff: at("2027-04-06T17:00:00Z"), status: "scheduled", round: 6 });
    await insertMatch(database.db, { seasonId: s.seasonId, homeClubId: fla, awayClubId: pal, kickoff: at("2027-04-05T20:00:00Z"), status: "postponed", round: 7 });
    await insertMatch(database.db, { seasonId: s.seasonId, homeClubId: fla, awayClubId: pal, kickoff: at("2027-04-05T21:00:00Z"), status: "cancelled", round: 8 });
    await insertMatch(database.db, { seasonId: s.seasonId, homeClubId: fla, awayClubId: pal, kickoff: at("2027-04-12T20:00:00Z"), status: "scheduled", round: 9 });

    const res = await markers();
    expect(res.games.map((g) => g.round)).toEqual([5, 6]);
    expect(res.games[0]).toMatchObject({ opponent: { ticker: "PAL3", name: "Palmeiras" }, home: true, status: "finished", goalsFor: 2, goalsAgainst: 1, result: "V" });
    expect(res.games[1]).toMatchObject({ status: "live", goalsFor: null, result: null, home: false });
    expect(res.games[1]!.opponent.ticker).toBeNull();
    // o mesmo jogo, do lado do PAL3: D
    const pal3 = await markers("7d", "PAL3");
    expect(pal3.games[0]).toMatchObject({ result: "D", opponent: { ticker: "FLA3" }, home: false });
  });

  it("dividendos: marcador no fechamento com R$ 0,30 e motivo, aguardando aprovação, e estorno depois de pago", async () => {
    const v1 = await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-5", perShare: 30, closedAt: at("2027-04-05T14:00:00Z"), status: "superseded", reason: "3 pontos na rodada 5", holdings: [] });
    await database.db.update(payoutEvents).set({ approvedAt: at("2027-04-05T12:00:00Z") }).where(eq(payoutEvents.id, v1));
    await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-5", perShare: 10, closedAt: at("2027-04-05T14:00:00Z"), version: 2, reason: "1 ponto na rodada 5", createdAt: at("2027-04-06T12:00:00Z"), holdings: [] }).then(async (id) => {
      await database.db.update(payoutEvents).set({ supersedesId: v1 }).where(eq(payoutEvents.id, id));
    });
    await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-6", perShare: 40, closedAt: at("2027-04-06T10:00:00Z"), status: "approved", reason: "4 pontos na rodada 6", holdings: [] });

    const res = await markers("7d", "PAL3");
    expect(res.payouts.map((p) => [p.kind, p.perShare, p.status])).toEqual([
      ["payout", 10, "pending"], // a versão atual do evento da rodada 5, aguardando aprovação
      ["payout", 40, "approved"],
      ["reversal", -20, "pending"], // a correção depois de paga: estorno de R$ 0,20 por ação
    ]);
    expect(res.payouts.find((p) => p.kind === "reversal")).toMatchObject({ reason: "1 ponto na rodada 5", perShare: -20 });
  });

  it("meus negócios: setas de Ana na abertura e na venda, nada de Bruno, e o preço médio; a rota privada pede login", async () => {
    const ana = await player();
    const bruno = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-04T20:00:00Z"), ipoBuy(fla, 1000, 3500));
    await applyMovements(database.db, ana.wallet, at("2027-04-06T16:00:00Z"), tradeSell(fla, 300, 4500));
    await applyMovements(database.db, ana.wallet, at("2027-04-06T16:30:00Z"), { kind: "adjustment", clubId: fla, sharesDelta: 5, costBasis: "purchase", price: 4000, reason: "crédito do admin" });
    await applyMovements(database.db, bruno.wallet, at("2027-04-06T15:00:00Z"), tradeBuy(pal, 10, 4000));

    const a = await mine(ana.account, "season");
    expect(a.trades).toEqual([
      { at: "2027-04-05T13:00:00.000Z", side: "buy", quantity: 1000, price: 3500 },
      { at: "2027-04-06T16:00:00.000Z", side: "sell", quantity: 300, price: 4500 },
    ]);
    expect(a.averagePrice).toBe(3504); // o crédito do admin entra no preço médio, mas não é negócio
    const b = await mine(bruno.account, "season");
    expect(b.trades).toEqual([]);
    expect(b.averagePrice).toBeNull();
    expect((await mine(bruno.account, "season", "PAL3")).trades).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/portfolio/clubs/FLA3/trades" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/clubs/XYZ9/markers" })).statusCode).toBe(404);
  });
});
