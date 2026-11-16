import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { bigId, futbolsa, instant, money, oneOf } from "./base.js";
import { users } from "./accounts.js";
import { BOT_PROFILES, COMPETITIONS, DIVISIONS, MATCH_STATUSES, SEASON_STATUSES } from "./values.js";

/** Dono: módulo `admin` (temporada, clubes, resultados, bots e registro). */

export const bots = futbolsa.table(
  "bots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    profile: text("profile").notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (t) => [check("bots_profile_check", oneOf(t.profile, BOT_PROFILES))],
);

/**
 * Clubes conhecidos, inclusive os não listados da Série B e das copas (que podem não
 * ter ticker). Listado é quem tem linha em `season_clubs`. Sem escudos oficiais.
 */
export const clubs = futbolsa.table("clubs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  ticker: text("ticker").unique(),
  name: text("name").notNull(),
  colorPrimary: text("color_primary"),
  colorSecondary: text("color_secondary"),
  badgeAbbr: text("badge_abbr"),
  /** O padrão do selo (`solido`, `listras`, `aros`…), a cor da sigla e a segunda cor do padrão tricolor (`CLUB_BADGES` do motor). */
  badgePattern: text("badge_pattern"),
  badgeInk: text("badge_ink"),
  badgeExtra: text("badge_extra"),
  /** Ids do clube em cada fonte de resultados, por exemplo `{ "football-data": 1783 }`. */
  externalIds: jsonb("external_ids").$type<Record<string, string | number>>().notNull().default({}),
});

export const seasons = futbolsa.table(
  "seasons",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    year: integer("year").notNull().unique(),
    status: text("status").notNull().default("preparing"),
    offerSize: integer("offer_size"),
    firstKickoff: instant("first_kickoff"),
    ipoOpensAt: instant("ipo_opens_at"),
    ipoClosesAt: instant("ipo_closes_at"),
    tradingOpensAt: instant("trading_opens_at"),
    tradingEndedAt: instant("trading_ended_at"),
    /** Quantidade da casa por lado: 25 pontos-base (0,25%) fora de jogo e 6 no modo de jogo. */
    mmQuantityBp: integer("mm_quantity_bp").notNull().default(25),
    mmMatchQuantityBp: integer("mm_match_quantity_bp").notNull().default(6),
    /** Mínimo de ações por lado: 10 fora de jogo e 3 no modo de jogo (rodada W da Calibração). */
    mmMinSideQty: integer("mm_min_side_qty").notNull().default(10),
    mmMatchMinSideQty: integer("mm_match_min_side_qty").notNull().default(3),
    /** Lote do formador: 2.000 pontos-base (20% da oferta), fixado na abertura do IPO. */
    mmLotBp: integer("mm_lot_bp").notNull().default(2000),
    botsInRankings: boolean("bots_in_rankings").notNull().default(false),
    suspendedReason: text("suspended_reason"),
    createdAt: instant("created_at").notNull().defaultNow(),
    closedAt: instant("closed_at"),
  },
  (t) => [
    check("seasons_status_check", oneOf(t.status, SEASON_STATUSES)),
    check("seasons_offer_size_check", sql`${t.offerSize} is null or ${t.offerSize} > 0`),
    check(
      "seasons_mm_bp_check",
      sql`${t.mmQuantityBp} between 0 and 10000 and ${t.mmMatchQuantityBp} between 0 and 10000 and ${t.mmLotBp} between 0 and 10000`,
    ),
    check("seasons_mm_min_side_qty_check", sql`${t.mmMinSideQty} >= 1 and ${t.mmMatchMinSideQty} >= 1`),
  ],
);

/** Clube listado numa temporada. É a linha travada pelo motor de ordens. */
export const seasonClubs = futbolsa.table(
  "season_clubs",
  {
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    division: text("division").notNull(),
    prevPlacement: integer("prev_placement"),
    bandCenter: money("band_center"),
    bandFloor: money("band_floor"),
    bandCeiling: money("band_ceiling"),
    ipoPrice: money("ipo_price"),
    /** Oferta + lote do formador + emitidas para novatos. */
    totalShares: integer("total_shares").notNull().default(0),
    suspendedReason: text("suspended_reason"),
    /** Preço exibido: o último negócio (antes dele, o preço do IPO). */
    lastPrice: money("last_price"),
    lastTradeAt: instant("last_trade_at"),
    mmRefreshedAt: instant("mm_refreshed_at"),
    /**
     * Referência do túnel de preço: o preço exibido às 0h de Brasília (na estreia, o de corte do IPO; depois de
     * um leilão com negócio, o preço dele). Vira na primeira transação do dia, com o clube travado, se o clube
     * não está em leilão (P9 do Plano do livro de ofertas e formador).
     */
    tunnelRef: money("tunnel_ref"),
    /** 0h de Brasília do dia a que a referência pertence. */
    tunnelRefDay: instant("tunnel_ref_day"),
    /** Leilão do túnel: quando abriu e quando termina. Parado pela suspensão: só `auction_opened_at`. */
    auctionOpenedAt: instant("auction_opened_at"),
    auctionUntil: instant("auction_until"),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.clubId] }),
    check("season_clubs_division_check", oneOf(t.division, DIVISIONS)),
    check("season_clubs_total_shares_check", sql`${t.totalShares} >= 0`),
    check("season_clubs_last_price_check", sql`${t.lastPrice} is null or ${t.lastPrice} > 0`),
    check("season_clubs_tunnel_ref_check", sql`${t.tunnelRef} is null or ${t.tunnelRef} > 0`),
    // o fim do leilão só existe com o início (sem fim = parado pela suspensão)
    check("season_clubs_auction_check", sql`${t.auctionUntil} is null or ${t.auctionOpenedAt} is not null`),
  ],
);

/** Classificação oficial importada da fonte de cada campeonato, conferida pelo admin. */
export const standings = futbolsa.table(
  "standings",
  {
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    competition: text("competition").notNull(),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    position: integer("position").notNull(),
    points: integer("points").notNull(),
    source: text("source"),
    manualOverride: boolean("manual_override").notNull().default(false),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedAt: instant("confirmed_at"),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.competition, t.clubId] }),
    check("standings_competition_check", oneOf(t.competition, COMPETITIONS)),
    check("standings_position_check", sql`${t.position} >= 1`),
  ],
);

export const matches = futbolsa.table(
  "matches",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    competition: text("competition").notNull(),
    round: integer("round"),
    phase: text("phase"),
    homeClubId: integer("home_club_id")
      .notNull()
      .references(() => clubs.id),
    awayClubId: integer("away_club_id")
      .notNull()
      .references(() => clubs.id),
    kickoff: instant("kickoff").notNull(),
    finishedAt: instant("finished_at"),
    homeGoals: integer("home_goals"),
    awayGoals: integer("away_goals"),
    /** Mata-mata: quem passou (inclusive nos pênaltis). */
    advancedClubId: integer("advanced_club_id").references(() => clubs.id),
    status: text("status").notNull().default("scheduled"),
    /** Jogo fora da janela da rodada (adiado ou antecipado), pela regra de `markOutOfWindow`. */
    outOfWindow: boolean("out_of_window").notNull().default(false),
    source: text("source"),
    sourceId: text("source_id"),
    /** Editado à mão: a importação não sobrescreve. */
    manualOverride: boolean("manual_override").notNull().default(false),
    /** O que a fonte disse por último. */
    sourceSnapshot: jsonb("source_snapshot"),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("matches_source_key").on(t.source, t.sourceId),
    index("matches_season_kickoff_idx").on(t.seasonId, t.kickoff),
    check("matches_competition_check", oneOf(t.competition, COMPETITIONS)),
    check("matches_status_check", oneOf(t.status, MATCH_STATUSES)),
    check("matches_clubs_check", sql`${t.homeClubId} <> ${t.awayClubId}`),
    check("matches_goals_check", sql`coalesce(${t.homeGoals}, 0) >= 0 and coalesce(${t.awayGoals}, 0) >= 0`),
  ],
);

/** Toda ação do admin, com autor, horário, antes, depois e motivo. Histórico. */
export const adminLog = futbolsa.table(
  "admin_log",
  {
    id: bigId("id").primaryKey().generatedAlwaysAsIdentity(),
    actorId: uuid("actor_id")
      .notNull()
      .references((): AnyPgColumn => users.id),
    at: instant("at").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
  },
  (t) => [index("admin_log_at_idx").on(t.at)],
);
