import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { applyTrade, candleStart, type Candle, type CandleInterval } from "@futbolsa/engine";
import { candles } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { recordTrade } from "../../src/modules/portfolio/candles/record-trade.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, seedSeason } from "../support/fixtures.js";

// P8 e T7 do Plano do livro de ofertas e formador: os candles de 15 minutos e do dia, atualizados a cada negócio.

describe("recordTrade (candles)", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let flaId: number;
  let palId: number;

  beforeAll(async () => {
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    await listClubs(t.db, seasonId, seeded.clubIds, ["FLA3", "PAL3"]);
    flaId = seeded.clubIds.get("FLA3")!;
    palId = seeded.clubIds.get("PAL3")!;
  });

  const record = (clubId: number, iso: string, price: number, quantity: number) =>
    withTransaction(t.db, (tx) => recordTrade(tx, { clubId, at: new Date(iso), price, quantity }));
  const stored = async (clubId: number, interval: CandleInterval, start: number) => {
    const [row] = await t.db
      .select()
      .from(candles)
      .where(and(eq(candles.clubId, clubId), eq(candles.interval, interval), eq(candles.start, new Date(start))));
    return row;
  };

  it("o primeiro negócio abre o candle de 15 minutos e o do dia, com a abertura, a máxima, a mínima e o fechamento iguais", async () => {
    const changed = await record(flaId, "2027-04-05T13:05:00Z", 4000, 10);
    expect(changed.map((c) => c.interval)).toEqual(["15m", "1d"]);
    const m15 = changed[0]!;
    expect(m15).toMatchObject({ open: 4000, high: 4000, low: 4000, close: 4000, volume: 10, turnover: 40_000 });
    expect(m15.start.toISOString()).toBe("2027-04-05T13:00:00.000Z");
    // o dia é de 0h a 24h de Brasília: 0h de 5/4 em Brasília = 03h UTC
    expect(changed[1]!.start.toISOString()).toBe("2027-04-05T03:00:00.000Z");
  });

  it("negócios seguintes no mesmo período mexem na máxima, na mínima, no fechamento e no volume, como o applyTrade do motor", async () => {
    const trades: [string, number, number][] = [
      ["2027-04-05T13:07:00Z", 4100, 5],
      ["2027-04-05T13:14:59Z", 3950, 20],
      ["2027-04-05T13:14:59Z", 4050, 1],
    ];
    for (const [iso, price, qty] of trades) await record(flaId, iso, price, qty);
    // a conta de referência: o motor
    let ref15: Candle | undefined;
    let ref1d: Candle | undefined;
    for (const [iso, price, qty] of [["2027-04-05T13:05:00Z", 4000, 10] as [string, number, number], ...trades]) {
      ref15 = applyTrade(ref15, "15m", Date.parse(iso), price, qty);
      ref1d = applyTrade(ref1d, "1d", Date.parse(iso), price, qty);
    }
    const m15 = await stored(flaId, "15m", candleStart("15m", Date.parse("2027-04-05T13:05:00Z")));
    const d1 = await stored(flaId, "1d", candleStart("1d", Date.parse("2027-04-05T13:05:00Z")));
    expect(m15).toMatchObject({ open: ref15!.open, high: ref15!.high, low: ref15!.low, close: ref15!.close, volume: ref15!.volume });
    expect(d1).toMatchObject({ open: ref1d!.open, high: ref1d!.high, low: ref1d!.low, close: ref1d!.close, volume: ref1d!.volume });
    expect(m15).toMatchObject({ open: 4000, high: 4100, low: 3950, close: 4050, volume: 36 });
  });

  it("um negócio no período seguinte abre outro candle de 15 minutos e continua o do dia", async () => {
    const changed = await record(flaId, "2027-04-05T13:15:00Z", 4200, 3);
    expect(changed[0]).toMatchObject({ open: 4200, volume: 3 });
    expect(changed[0]!.start.toISOString()).toBe("2027-04-05T13:15:00.000Z");
    expect(changed[1]).toMatchObject({ open: 4000, high: 4200, low: 3950, close: 4200, volume: 39 });
  });

  it("virou o dia em Brasília (3h UTC): o candle do dia é outro", async () => {
    await record(palId, "2027-04-06T02:59:59Z", 3000, 1);
    const next = await record(palId, "2027-04-06T03:00:00Z", 3100, 1);
    expect(next[1]).toMatchObject({ open: 3100, volume: 1 });
    expect(next[1]!.start.toISOString()).toBe("2027-04-06T03:00:00.000Z");
  });

  it("os clubes não se misturam", async () => {
    const pal = await stored(palId, "1d", candleStart("1d", Date.parse("2027-04-05T20:00:00Z")));
    expect(pal).toMatchObject({ open: 3000, close: 3000, volume: 1 });
  });

  it("negócios ao mesmo tempo no mesmo clube somam o volume sem perder nenhum (a trava do clube serializa, o upsert não perde)", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => record(palId, "2027-04-07T13:00:00Z", 3000 + i, 2)));
    const row = await stored(palId, "15m", candleStart("15m", Date.parse("2027-04-07T13:00:00Z")));
    expect(row!.volume).toBe(20);
    expect(row!.high).toBe(3009);
    expect(row!.low).toBe(3000);
  });

  it("quantidade ou preço inválidos são erro de programação", async () => {
    await expect(record(flaId, "2027-04-08T13:00:00Z", 4000, 0)).rejects.toThrow();
    await expect(record(flaId, "2027-04-08T13:00:00Z", 40.5, 1)).rejects.toThrow();
  });
});
