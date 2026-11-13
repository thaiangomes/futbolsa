/**
 * Valores aceitos das colunas de estado. No banco são `text` com `CHECK` (e não
 * `enum` do Postgres): acrescentar um valor com o jogo no ar é trocar um CHECK.
 */

export const USER_ROLES = ["player", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "blocked", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Os 9 perfis de bot de `src/sim/bots.ts` (PROFILES). */
export const BOT_PROFILES = [
  "dividendos",
  "momentum",
  "torcedor",
  "aleatorio",
  "trader",
  "captura",
  "analista",
  "concentrador",
  "antecipador",
] as const;
export type BotProfileValue = (typeof BOT_PROFILES)[number];

export const SEASON_STATUSES = ["preparing", "ipo_open", "ipo_closed", "trading", "trading_ended", "closed"] as const;
export type SeasonStatus = (typeof SEASON_STATUSES)[number];

export const DIVISIONS = ["A", "B"] as const;
export type Division = (typeof DIVISIONS)[number];

/** Códigos das competições, os mesmos do motor (`Match.competition`). */
export const COMPETITIONS = ["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sulamericana"] as const;
export type Competition = (typeof COMPETITIONS)[number];

export const CUP_COMPETITIONS = ["copa-do-brasil", "libertadores", "sulamericana"] as const;

export const MATCH_STATUSES = ["scheduled", "finished", "postponed", "cancelled"] as const;
export type MatchStatusValue = (typeof MATCH_STATUSES)[number];

export const WALLET_OWNER_TYPES = ["user", "bot", "treasury"] as const;
export type WalletOwnerType = (typeof WALLET_OWNER_TYPES)[number];

export const ENTRY_MODES = ["ipo", "index", "cash"] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

export const WALLET_ENTRY_KINDS = [
  "initial",
  "ipo_reserve",
  "ipo_settle",
  "index_entry",
  "trade",
  "order_reserve",
  "order_release",
  "dividend",
  "reversal",
  "complement",
  "adjustment",
  "buyback",
  "season_close",
  "account_deleted",
  "trade_annulled",
] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

export const IPO_BID_STATUSES = ["active", "cancelled", "settled"] as const;
export type IpoBidStatus = (typeof IPO_BID_STATUSES)[number];

export const ORDER_SIDES = ["buy", "sell"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_TYPES = ["limit", "market"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = ["open", "filled", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_CANCEL_REASONS = [
  "player",
  "blocked",
  "deleted",
  "bot_off",
  "reversal",
  "trading_end",
  "house_refresh",
  "suspension",
  "market_remainder",
  "annulment",
] as const;
export type OrderCancelReason = (typeof ORDER_CANCEL_REASONS)[number];

/** Por que a casa precisa repor a cotação fora dos horários. */
export const REFRESH_REASONS = ["score", "correction", "close", "resume"] as const;
export type RefreshReason = (typeof REFRESH_REASONS)[number];

export const CANDLE_INTERVALS = ["15m", "1d"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const PAYOUT_KINDS = ["points", "placement", "cup_phase", "cup_title", "promotion", "buyback"] as const;
export type PayoutKindValue = (typeof PAYOUT_KINDS)[number];

export const PAYOUT_STATUSES = ["pending", "approved", "superseded"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export const RANKING_PERIODS = ["month", "season"] as const;
export type RankingPeriod = (typeof RANKING_PERIODS)[number];

/** Caso de trapaça entre contas (F14, pista D): de onde veio e como está. */
export const FRAUD_CASE_ORIGINS = ["alert", "manual"] as const;
export type FraudCaseOrigin = (typeof FRAUD_CASE_ORIGINS)[number];
export const FRAUD_CASE_STATUSES = ["open", "confirmed", "dismissed"] as const;
export type FraudCaseStatus = (typeof FRAUD_CASE_STATUSES)[number];

/** Avisos ao jogador (F14). */
export const PLAYER_NOTICE_KINDS = ["fraud_warning", "fraud_ban"] as const;
export type PlayerNoticeKind = (typeof PLAYER_NOTICE_KINDS)[number];
