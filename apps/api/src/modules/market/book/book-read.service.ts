import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { clubChannel, type BookView, type ClubList, type MarketState } from "@futbolsa/contracts";
import { dayStart, tradingBand } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs, positions, seasonClubs, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { EventBus } from "../../../infra/realtime/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { auctionStateOf } from "../state/auction-states.js";
import { changeBp, dayOpenPrice, displayedPriceOf, displayedPrices } from "../state/displayed-price.js";
import { tradingGate } from "../state/gate.js";
import { clubsInMatch, inMatch } from "../state/match-mode.js";
import { readBookLevels, readRecentTrades } from "./book-repo.js";

type SeasonRow = NonNullable<Awaited<ReturnType<typeof currentSeason>>>;

/** O estado do mercado como a tela o mostra: `not_open` antes da estreia, `ended` depois do fim, `suspended` com o motivo. */
export function marketStateOf(season: SeasonRow, club: { suspendedReason: string | null }, now: Date): MarketState {
  const opensAt = season.tradingOpensAt?.toISOString() ?? null;
  const gate = tradingGate(season, club, now);
  if (gate.open) return { state: "open", opensAt, reason: null };
  if (gate.code === "club_suspended") return { state: "suspended", opensAt, reason: gate.reason };
  const ended = season.status === "trading_ended" || season.status === "closed" || (season.tradingEndedAt !== null && now >= season.tradingEndedAt);
  return { state: ended ? "ended" : "not_open", opensAt, reason: null };
}

/**
 * As leituras públicas do mercado (T8 e L8): `GET /clubs/:ticker/book` e `GET /clubs`. Sem trava: o `seq` do canal é
 * lido **antes** do banco (P2 do Plano do WebSocket), então um evento publicado no meio da leitura chega de novo ao
 * cliente em vez de se perder. Quem está logado recebe também a faixa de 20% e o saldo livre.
 */
@Injectable()
export class BookReadService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  async book(ticker: string, userId: string | null): Promise<BookView> {
    const seq = this.bus.currentSeq(clubChannel(ticker));
    const now = this.clock.now();
    const season = await currentSeason(this.db);
    if (!season) throw notListed();
    const [club] = await this.db
      .select({ ...seasonClubsColumns })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, season.id), eq(clubs.ticker, ticker)));
    if (!club) throw notListed();

    const displayed = displayedPriceOf(club);
    const open = await dayOpenPrice(this.db, season.id, ticker, now);
    const [levels, trades, matchMode, me] = await Promise.all([
      readBookLevels(this.db, club.clubId),
      readRecentTrades(this.db, club.clubId),
      inMatch(this.db, season.id, club.clubId, now),
      userId ? this.balances(season.id, club.clubId, userId) : Promise.resolve(null),
    ]);
    return {
      ticker,
      seq,
      price: { displayed, open, changeBp: changeBp(displayed, open) },
      matchMode,
      auction: auctionStateOf(club),
      market: marketStateOf(season, { suspendedReason: club.suspendedReason }, now),
      bids: levels.bids,
      asks: levels.asks,
      trades,
      me: me ? { band: tradingBand(displayed), ...me } : null,
    };
  }

  /** O caixa e as ações livres do jogador no clube; `null` se ele não tem carteira nesta temporada. */
  private async balances(seasonId: number, clubId: number, userId: string): Promise<{ freeCash: number; freeShares: number } | null> {
    const [wallet] = await this.db
      .select({ id: wallets.id, cash: wallets.cash, reserved: wallets.reservedCash })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, userId)));
    if (!wallet) return null;
    const [position] = await this.db
      .select({ shares: positions.shares, reserved: positions.reservedShares })
      .from(positions)
      .where(and(eq(positions.walletId, wallet.id), eq(positions.clubId, clubId)));
    return { freeCash: wallet.cash - wallet.reserved, freeShares: position ? position.shares - position.reserved : 0 };
  }

  /** A lista dos clubes da temporada com preço, variação do dia, jogo, leilão e suspensão. */
  async list(): Promise<ClubList> {
    const seq = this.bus.currentSeq("prices");
    const now = this.clock.now();
    const season = await currentSeason(this.db);
    if (!season) return { seq, market: { state: "not_open", opensAt: null, reason: null }, clubs: [] };
    const rows = await this.db
      .select({ ...seasonClubsColumns, name: clubs.name, division: seasonClubs.division })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, season.id));
    const opens = await displayedPrices(this.db, season.id, new Date(dayStart(now.getTime())));
    const playing = new Set(await clubsInMatch(this.db, season.id, now));
    return {
      seq,
      market: marketStateOf(season, { suspendedReason: null }, now),
      clubs: rows
        .map((r) => {
          const price = displayedPriceOf(r);
          const suspended = r.suspendedReason ?? season.suspendedReason;
          return {
            ticker: r.ticker!,
            name: r.name,
            division: r.division as "A" | "B",
            price,
            changeBp: changeBp(price, opens.get(r.ticker!) ?? price),
            matchMode: playing.has(r.clubId),
            auction: auctionStateOf(r),
            suspended: suspended === null ? null : { reason: suspended },
          };
        })
        .sort((a, b) => a.ticker.localeCompare(b.ticker)),
    };
  }
}

const seasonClubsColumns = {
  clubId: seasonClubs.clubId,
  ticker: clubs.ticker,
  lastPrice: seasonClubs.lastPrice,
  ipoPrice: seasonClubs.ipoPrice,
  suspendedReason: seasonClubs.suspendedReason,
  auctionOpenedAt: seasonClubs.auctionOpenedAt,
  auctionUntil: seasonClubs.auctionUntil,
};

const notListed = () => new DomainError("club_not_listed", 404, "Este clube não está listado na temporada.");
