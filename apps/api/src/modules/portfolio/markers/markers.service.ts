import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { ChartRange, MarkersResponse, MyTradesResponse } from "@futbolsa/contracts";
import { COMMON_ERROR_MESSAGES } from "@futbolsa/contracts";
import { averagePrice } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs, matches, payoutEvents, positions, seasonClubs, walletEntries, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { listedClub } from "../candles/candles.service.js";
import { chartWindow } from "../candles/windows.js";
import { WALLET_NOT_FOUND } from "../wallet/wallet.service.js";
import { type GameRow, gameMarkers } from "./games.js";
import { MY_TRADES_LIMIT, myTrades } from "./my-trades.js";
import { payoutMarkers } from "./payouts.js";

/**
 * Os marcadores do gráfico do clube. A rota pública traz jogos e dividendos (iguais para todos, então podem ir para o
 * cache); a privada traz os meus negócios e o meu preço médio, só do dono da carteira (P1). Só `SELECT` nas tabelas dos
 * outros módulos (P3), sempre da temporada atual.
 */
@Injectable()
export class MarkersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async public(ticker: string, range: ChartRange, now: Date = this.clock.now()): Promise<MarkersResponse> {
    const club = await listedClub(this.db, ticker);
    const w = chartWindow(range, now, club.tradingOpensAt, club.tradingEndedAt);
    if (w.beforeOpening) return { range, games: [], payouts: [] };
    const from = new Date(w.from);
    const to = new Date(w.to);

    // jogos: o clube em casa ou fora, na janela; os que ainda não terminaram só entram se o início já passou
    const rows = await this.db
      .select()
      .from(matches)
      .where(
        and(
          eq(matches.seasonId, club.seasonId),
          or(eq(matches.homeClubId, club.clubId), eq(matches.awayClubId, club.clubId)),
          ne(matches.status, "cancelled"),
          ne(matches.status, "postponed"),
          gte(matches.kickoff, from),
          lte(matches.kickoff, to),
        ),
      )
      .orderBy(asc(matches.kickoff));
    const opponentIds = [...new Set(rows.map((m) => (m.homeClubId === club.clubId ? m.awayClubId : m.homeClubId)))];
    const opponents = opponentIds.length
      ? await this.db
          .select({ id: clubs.id, ticker: clubs.ticker, name: clubs.name, listed: seasonClubs.clubId })
          .from(clubs)
          .leftJoin(seasonClubs, and(eq(seasonClubs.clubId, clubs.id), eq(seasonClubs.seasonId, club.seasonId)))
          .where(inArray(clubs.id, opponentIds))
      : [];
    const byId = new Map(opponents.map((o) => [o.id, o]));
    const gameRows: GameRow[] = rows.map((m) => {
      const o = byId.get(m.homeClubId === club.clubId ? m.awayClubId : m.homeClubId);
      return {
        kickoff: m.kickoff,
        status: m.status,
        competition: m.competition,
        round: m.round,
        phase: m.phase,
        homeClubId: m.homeClubId,
        awayClubId: m.awayClubId,
        homeGoals: m.homeGoals,
        awayGoals: m.awayGoals,
        advancedClubId: m.advancedClubId,
        opponent: { ticker: o?.listed != null ? o.ticker : null, name: o?.name ?? "?" },
      };
    });

    const events = await this.db
      .select({
        id: payoutEvents.id,
        eventKey: payoutEvents.eventKey,
        kind: payoutEvents.kind,
        reason: payoutEvents.reason,
        perShare: payoutEvents.perShare,
        closedAt: payoutEvents.closedAt,
        status: payoutEvents.status,
        supersedesId: payoutEvents.supersedesId,
        approvedAt: payoutEvents.approvedAt,
        createdAt: payoutEvents.createdAt,
      })
      .from(payoutEvents)
      .where(and(eq(payoutEvents.seasonId, club.seasonId), eq(payoutEvents.clubId, club.clubId), lte(payoutEvents.closedAt, now)));
    return { range, games: gameMarkers(club.clubId, gameRows, now), payouts: payoutMarkers(events, from, to) };
  }

  /** Os meus negócios no clube e o meu preço médio (nulo sem ações). */
  async mine(userId: string, ticker: string, range: ChartRange, now: Date = this.clock.now()): Promise<MyTradesResponse> {
    const club = await listedClub(this.db, ticker);
    const [wallet] = await this.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, club.seasonId), eq(wallets.userId, userId)));
    if (!wallet) throw new DomainError(WALLET_NOT_FOUND, 404, COMMON_ERROR_MESSAGES.not_found);
    const w = chartWindow(range, now, club.tradingOpensAt, club.tradingEndedAt);
    const [position] = await this.db.select().from(positions).where(and(eq(positions.walletId, wallet.id), eq(positions.clubId, club.clubId)));
    const avg = position && position.shares > 0 ? averagePrice({ shares: position.shares, cost: position.cost, realized: position.realized, dividends: position.dividends }) : null;
    if (w.beforeOpening) return { range, trades: [], averagePrice: avg };
    // a alocação do IPO pode ter sido liquidada antes da abertura e aparece "na abertura": por isso a janela olha o horário ajustado
    const rows = await this.db
      .select({ at: walletEntries.at, kind: walletEntries.kind, sharesDelta: walletEntries.sharesDelta, cashDelta: walletEntries.cashDelta, price: walletEntries.price })
      .from(walletEntries)
      .where(
        and(
          eq(walletEntries.walletId, wallet.id),
          eq(walletEntries.clubId, club.clubId),
          inArray(walletEntries.kind, ["trade", "ipo_settle", "index_entry", "buyback"]),
          lte(walletEntries.at, new Date(w.to)),
          // o negócio que o admin anulou por inteiro não é marcador (o que sobrou por falta de ações continua)
          sql`not exists (select 1 from futbolsa.trade_annulments ta where ${walletEntries.refType} = 'trade' and ta.trade_id = case when ${walletEntries.refType} = 'trade' then ${walletEntries.refId}::bigint end and ta.shares_short = 0)`,
        ),
      )
      .orderBy(desc(walletEntries.at), desc(walletEntries.id))
      .limit(MY_TRADES_LIMIT * 2);
    const from = w.from;
    const trades = myTrades(rows, club.tradingOpensAt).filter((t) => new Date(t.at).getTime() >= from);
    return { range, trades, averagePrice: avg };
  }
}
