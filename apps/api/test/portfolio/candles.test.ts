import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CandlesResponse, candlesResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { seasons } from "../../src/infra/db/schema/index.js";
import { chartWindow } from "../../src/modules/portfolio/candles/windows.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createTestApp } from "../support/app.js";
import { useTestDatabase } from "../support/db.js";
import { assertCandlesMatchTrades } from "../support/invariants.js";
import { insertTrade } from "../market/helpers.js";
import { AFTER_OPEN, portfolioSeason, type PortfolioSeason } from "./support.js";

// T7: GET /clubs/:ticker/candles (Carteira e gráficos 22 e 23).

const at = (iso: string) => new Date(iso);

describe("chartWindow", () => {
  const opens = at("2027-04-05T13:00:00Z");
  it("hoje: 15 minutos desde 0h de Brasília; 7 e 30 dias contam o dia de hoje e nunca começam antes da abertura", () => {
    const now = at("2027-04-20T18:00:00Z");
    expect(chartWindow("today", now, opens, null)).toMatchObject({ interval: "15m", from: at("2027-04-20T03:00:00Z").getTime(), to: now.getTime() });
    expect(chartWindow("7d", now, opens, null).from).toBe(at("2027-04-14T03:00:00Z").getTime());
    expect(chartWindow("30d", now, opens, null).from).toBe(opens.getTime());
    expect(chartWindow("season", now, opens, null)).toMatchObject({ interval: "1d", from: opens.getTime() });
  });
  it("depois do fim da negociação a janela para no fim; antes da abertura é vazia", () => {
    const ended = at("2027-04-22T12:00:00Z");
    expect(chartWindow("7d", at("2027-04-25T12:00:00Z"), opens, ended).to).toBe(ended.getTime());
    expect(chartWindow("today", at("2027-04-01T12:00:00Z"), opens, null).beforeOpening).toBe(true);
    expect(chartWindow("today", at("2027-04-01T12:00:00Z"), null, null).beforeOpening).toBe(true);
  });
});

describe("GET /clubs/:ticker/candles", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let fla: number;

  const trade = async (when: string, price: number, quantity: number) => {
    await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: at(when), price, quantity, buyerWalletId: s.buyer, sellerWalletId: s.seller });
    await withTransaction(database.db, (tx) => new PortfolioLedger().recordTrade(tx, { clubId: fla, at: at(when), price, quantity }));
  };
  const get = async (range: string, ticker = "FLA3"): Promise<CandlesResponse> => {
    const res = await app.inject({ method: "GET", url: `/clubs/${ticker}/candles?range=${range}` });
    expect(res.statusCode).toBe(200);
    return candlesResponseSchema.parse(res.json());
  };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock });
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    // dia 5 (abertura às 10h): um negócio às 23h59 de Brasília (02h59 UTC do dia 6) ainda é do dia 5
    await trade("2027-04-05T14:00:00Z", 4100, 10);
    await trade("2027-04-06T02:59:00Z", 4300, 4);
    // dia 6: dois negócios no mesmo candle de 15 minutos (10h05 e 10h10) e um às 11h
    await trade("2027-04-06T13:05:00Z", 4100, 10);
    await trade("2027-04-06T13:10:00Z", 4200, 5);
    await trade("2027-04-06T14:01:00Z", 4150, 2);
  });
  afterAll(async () => {
    await assertCandlesMatchTrades(database.db, s.seasonId);
    await app.close();
  });

  it("é pública e o ticker de clube não listado dá 404; período inválido dá 400", async () => {
    expect((await app.inject({ method: "GET", url: "/clubs/XYZ9/candles" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/clubs/FLA3/candles?range=1y" })).statusCode).toBe(400);
  });

  it("carteira 22 e 23: hoje, candles de 15 minutos com volume; antes do primeiro negócio de hoje repete o fechamento anterior", async () => {
    const res = await get("today");
    expect(res).toMatchObject({ range: "today", interval: "15m", ipoPrice: 4000, from: "2027-04-06T03:00:00.000Z" });
    const byStart = new Map(res.candles.map((c) => [c.start, c]));
    // das 0h às 10h: nenhum negócio hoje, vale o fechamento de ontem (R$ 43,00)
    expect(res.candles[0]).toMatchObject({ start: "2027-04-06T03:00:00.000Z", close: 4300, volume: 0, turnover: 0 });
    expect(byStart.get("2027-04-06T13:00:00.000Z")).toMatchObject({ open: 4100, high: 4200, low: 4100, close: 4200, volume: 15 });
    expect(byStart.get("2027-04-06T14:00:00.000Z")).toMatchObject({ open: 4150, close: 4150, volume: 2 });
    // depois do último negócio repete R$ 41,50 com volume zero, até agora (15h de Brasília = 18h UTC)
    expect(res.candles.at(-1)).toMatchObject({ start: "2027-04-06T18:00:00.000Z", close: 4150, volume: 0 });
    expect(res.candles).toHaveLength(61);
  });

  it("7 dias: o dia atual conta e a fronteira da meia-noite de Brasília separa os dias", async () => {
    const res = await get("7d");
    expect(res.interval).toBe("1d");
    // a janela não começa antes da abertura (dia 5): dois candles diários
    expect(res.candles.map((c) => c.start)).toEqual(["2027-04-05T03:00:00.000Z", "2027-04-06T03:00:00.000Z"]);
    expect(res.candles[0]).toMatchObject({ open: 4100, close: 4300, volume: 14 });
    expect(res.candles[1]).toMatchObject({ open: 4100, high: 4200, low: 4100, close: 4150, volume: 17 });
  });

  it("temporada: diários desde a abertura; sem negócio num dia repete o fechamento (volume zero)", async () => {
    clock.set(at("2027-04-09T18:00:00Z"));
    const res = await get("season");
    clock.set(AFTER_OPEN);
    expect(res.candles.map((c) => [c.start.slice(0, 10), c.close, c.volume])).toEqual([
      ["2027-04-05", 4300, 14],
      ["2027-04-06", 4150, 17],
      ["2027-04-07", 4150, 0],
      ["2027-04-08", 4150, 0],
      ["2027-04-09", 4150, 0],
    ]);
  });

  it("clube sem negócio: a linha fica no preço do IPO", async () => {
    const res = await get("today", "PAL3");
    expect(res.candles.every((c) => c.close === 4000 && c.volume === 0)).toBe(true);
  });

  it("antes da abertura a resposta vem vazia com o horário da abertura", async () => {
    await database.db.update(seasons).set({ tradingOpensAt: at("2027-04-20T13:00:00Z") }).where(eq(seasons.id, s.seasonId));
    const res = await get("today");
    await database.db.update(seasons).set({ tradingOpensAt: at("2027-04-05T13:00:00Z") }).where(eq(seasons.id, s.seasonId));
    expect(res.candles).toEqual([]);
    expect(res.tradingOpensAt).toBe("2027-04-20T13:00:00.000Z");
  });

  it("o seq do canal do clube vem na resposta", async () => {
    expect((await get("today")).seq).toBeGreaterThanOrEqual(0);
  });
});
