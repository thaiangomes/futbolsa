import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, lt, lte } from "drizzle-orm";
import type { CandlesResponse, ChartRange } from "@futbolsa/contracts";
import { type Candle, candleStart, fillGaps } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { candles, clubs, seasonClubs, seasons } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { EventBus } from "../../../infra/realtime/index.js";
import { clubChannel } from "@futbolsa/contracts";
import { currentSeason } from "../../admin/current-season.js";
import { chartWindow } from "./windows.js";

export const CLUB_NOT_LISTED = "club_not_listed";

/** O clube listado na temporada atual com o que o gráfico precisa; 404 se o ticker não está listado. */
export async function listedClub(db: Database, ticker: string) {
  const season = await currentSeason(db);
  if (!season) throw new DomainError(CLUB_NOT_LISTED, 404, "Este clube não está listado na temporada.");
  const [club] = await db
    .select({
      clubId: clubs.id,
      ticker: clubs.ticker,
      ipoPrice: seasonClubs.ipoPrice,
      lastPrice: seasonClubs.lastPrice,
      tradingOpensAt: seasons.tradingOpensAt,
      tradingEndedAt: seasons.tradingEndedAt,
    })
    .from(seasonClubs)
    .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
    .innerJoin(seasons, eq(seasons.id, seasonClubs.seasonId))
    .where(and(eq(seasonClubs.seasonId, season.id), eq(clubs.ticker, ticker)));
  if (!club) throw new DomainError(CLUB_NOT_LISTED, 404, "Este clube não está listado na temporada.");
  return { seasonId: season.id, ...club };
}

/**
 * `GET /clubs/:ticker/candles` (público): os candles da janela do período, com o período sem negócio repetindo o
 * fechamento e, antes do primeiro negócio, o preço do IPO (`fillGaps` do motor). O `seq` do canal do clube é lido antes do
 * banco: no pior caso o `candle` ao vivo chega de novo, e ele traz valores absolutos, então reaplicar não muda nada.
 */
@Injectable()
export class CandlesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly bus: EventBus,
  ) {}

  async get(ticker: string, range: ChartRange, now: Date = this.clock.now()): Promise<CandlesResponse> {
    const seq = this.bus.currentSeq(clubChannel(ticker));
    const club = await listedClub(this.db, ticker);
    const window = chartWindow(range, now, club.tradingOpensAt, club.tradingEndedAt);
    const base = {
      seq,
      range,
      interval: window.interval,
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
      ipoPrice: club.ipoPrice,
      tradingOpensAt: club.tradingOpensAt?.toISOString() ?? null,
    };
    const startPrice = club.ipoPrice ?? club.lastPrice;
    if (window.beforeOpening || startPrice === null) return { ...base, candles: [] };

    const first = candleStart(window.interval, window.from);
    const rows = await this.db
      .select()
      .from(candles)
      .where(and(eq(candles.clubId, club.clubId), eq(candles.interval, window.interval), gte(candles.start, new Date(first)), lte(candles.start, new Date(window.to))))
      .orderBy(asc(candles.start));
    // o último candle de antes da janela só serve de fechamento de partida
    const [earlier] = await this.db
      .select()
      .from(candles)
      .where(and(eq(candles.clubId, club.clubId), eq(candles.interval, window.interval), lt(candles.start, new Date(first))))
      .orderBy(desc(candles.start))
      .limit(1);
    const toEngine = (c: typeof candles.$inferSelect): Candle => ({ start: c.start.getTime(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    const series = fillGaps([...(earlier ? [toEngine(earlier)] : []), ...rows.map(toEngine)], window.interval, window.from, window.to, startPrice);
    return {
      ...base,
      candles: series.map((c) => ({ start: new Date(c.start).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
    };
  }
}
