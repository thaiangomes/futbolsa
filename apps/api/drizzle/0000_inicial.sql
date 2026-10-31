CREATE SCHEMA "futbolsa";
--> statement-breakpoint
CREATE TABLE "futbolsa"."auth_identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_provider_subject_pk" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."invites" (
	"email" text PRIMARY KEY NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "invites_email_lower_check" CHECK ("futbolsa"."invites"."email" = lower("futbolsa"."invites"."email"))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."season_results" (
	"user_id" uuid NOT NULL,
	"season_id" integer NOT NULL,
	"final_equity" bigint NOT NULL,
	"base" bigint NOT NULL,
	"position" integer,
	CONSTRAINT "season_results_user_id_season_id_pk" PRIMARY KEY("user_id","season_id")
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"nickname" text,
	"role" text DEFAULT 'player' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"terms_accepted_at" timestamp with time zone,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_role_check" CHECK ("futbolsa"."users"."role" in ('player', 'admin')),
	CONSTRAINT "users_status_check" CHECK ("futbolsa"."users"."status" in ('active', 'blocked', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."admin_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."admin_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."bots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."bots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"profile" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bots_profile_check" CHECK ("futbolsa"."bots"."profile" in ('dividendos', 'momentum', 'torcedor', 'aleatorio', 'trader', 'captura', 'analista', 'concentrador', 'antecipador'))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."clubs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."clubs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"ticker" text,
	"name" text NOT NULL,
	"color_primary" text,
	"color_secondary" text,
	"badge_abbr" text,
	"external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "clubs_ticker_unique" UNIQUE("ticker")
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."matches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."matches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"competition" text NOT NULL,
	"round" integer,
	"phase" text,
	"home_club_id" integer NOT NULL,
	"away_club_id" integer NOT NULL,
	"kickoff" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"home_goals" integer,
	"away_goals" integer,
	"advanced_club_id" integer,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"out_of_window" boolean DEFAULT false NOT NULL,
	"source" text,
	"source_id" text,
	"manual_override" boolean DEFAULT false NOT NULL,
	"source_snapshot" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_source_key" UNIQUE("source","source_id"),
	CONSTRAINT "matches_competition_check" CHECK ("futbolsa"."matches"."competition" in ('brasileirao-a', 'brasileirao-b', 'copa-do-brasil', 'libertadores', 'sulamericana')),
	CONSTRAINT "matches_status_check" CHECK ("futbolsa"."matches"."status" in ('scheduled', 'finished', 'postponed', 'cancelled')),
	CONSTRAINT "matches_clubs_check" CHECK ("futbolsa"."matches"."home_club_id" <> "futbolsa"."matches"."away_club_id"),
	CONSTRAINT "matches_goals_check" CHECK (coalesce("futbolsa"."matches"."home_goals", 0) >= 0 and coalesce("futbolsa"."matches"."away_goals", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."season_clubs" (
	"season_id" integer NOT NULL,
	"club_id" integer NOT NULL,
	"division" text NOT NULL,
	"prev_placement" integer,
	"band_center" bigint,
	"band_floor" bigint,
	"band_ceiling" bigint,
	"ipo_price" bigint,
	"total_shares" integer DEFAULT 0 NOT NULL,
	"suspended_reason" text,
	"last_price" bigint,
	"last_trade_at" timestamp with time zone,
	"mm_refreshed_at" timestamp with time zone,
	CONSTRAINT "season_clubs_season_id_club_id_pk" PRIMARY KEY("season_id","club_id"),
	CONSTRAINT "season_clubs_division_check" CHECK ("futbolsa"."season_clubs"."division" in ('A', 'B')),
	CONSTRAINT "season_clubs_total_shares_check" CHECK ("futbolsa"."season_clubs"."total_shares" >= 0),
	CONSTRAINT "season_clubs_last_price_check" CHECK ("futbolsa"."season_clubs"."last_price" is null or "futbolsa"."season_clubs"."last_price" > 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."seasons" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."seasons_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"year" integer NOT NULL,
	"status" text DEFAULT 'preparing' NOT NULL,
	"offer_size" integer,
	"first_kickoff" timestamp with time zone,
	"ipo_opens_at" timestamp with time zone,
	"ipo_closes_at" timestamp with time zone,
	"trading_opens_at" timestamp with time zone,
	"trading_ended_at" timestamp with time zone,
	"mm_quantity_bp" integer DEFAULT 25 NOT NULL,
	"mm_match_quantity_bp" integer DEFAULT 6 NOT NULL,
	"mm_min_side_qty" integer,
	"mm_lot_bp" integer DEFAULT 1000 NOT NULL,
	"bots_in_rankings" boolean DEFAULT false NOT NULL,
	"suspended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "seasons_year_unique" UNIQUE("year"),
	CONSTRAINT "seasons_status_check" CHECK ("futbolsa"."seasons"."status" in ('preparing', 'ipo_open', 'ipo_closed', 'trading', 'trading_ended', 'closed')),
	CONSTRAINT "seasons_offer_size_check" CHECK ("futbolsa"."seasons"."offer_size" is null or "futbolsa"."seasons"."offer_size" > 0),
	CONSTRAINT "seasons_mm_bp_check" CHECK ("futbolsa"."seasons"."mm_quantity_bp" between 0 and 10000 and "futbolsa"."seasons"."mm_match_quantity_bp" between 0 and 10000 and "futbolsa"."seasons"."mm_lot_bp" between 0 and 10000),
	CONSTRAINT "seasons_mm_min_side_qty_check" CHECK ("futbolsa"."seasons"."mm_min_side_qty" is null or "futbolsa"."seasons"."mm_min_side_qty" >= 1)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."standings" (
	"season_id" integer NOT NULL,
	"competition" text NOT NULL,
	"club_id" integer NOT NULL,
	"position" integer NOT NULL,
	"points" integer NOT NULL,
	"source" text,
	"manual_override" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "standings_season_id_competition_club_id_pk" PRIMARY KEY("season_id","competition","club_id"),
	CONSTRAINT "standings_competition_check" CHECK ("futbolsa"."standings"."competition" in ('brasileirao-a', 'brasileirao-b', 'copa-do-brasil', 'libertadores', 'sulamericana')),
	CONSTRAINT "standings_position_check" CHECK ("futbolsa"."standings"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."cup_phases" (
	"season_id" integer NOT NULL,
	"competition" text NOT NULL,
	"phase_key" text NOT NULL,
	"variant" text DEFAULT 'advance' NOT NULL,
	"ord" integer NOT NULL,
	"per_share" bigint NOT NULL,
	CONSTRAINT "cup_phases_season_id_competition_phase_key_variant_pk" PRIMARY KEY("season_id","competition","phase_key","variant"),
	CONSTRAINT "cup_phases_competition_check" CHECK ("futbolsa"."cup_phases"."competition" in ('copa-do-brasil', 'libertadores', 'sulamericana')),
	CONSTRAINT "cup_phases_variant_check" CHECK ("futbolsa"."cup_phases"."variant" in ('advance', 'title') or "futbolsa"."cup_phases"."variant" like 'to:%'),
	CONSTRAINT "cup_phases_per_share_check" CHECK ("futbolsa"."cup_phases"."per_share" >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."season_cups" (
	"season_id" integer NOT NULL,
	"competition" text NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "season_cups_season_id_competition_pk" PRIMARY KEY("season_id","competition"),
	CONSTRAINT "season_cups_competition_check" CHECK ("futbolsa"."season_cups"."competition" in ('copa-do-brasil', 'libertadores', 'sulamericana'))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."season_rules" (
	"season_id" integer PRIMARY KEY NOT NULL,
	"a_per_point" bigint NOT NULL,
	"b_per_point" bigint NOT NULL,
	"a_placement" bigint[] NOT NULL,
	"promotion_per_share" bigint NOT NULL,
	"promotion_slots" integer NOT NULL,
	"buyback_multiple_bp" integer DEFAULT 15000 NOT NULL,
	"locked_at" timestamp with time zone,
	CONSTRAINT "season_rules_values_check" CHECK ("futbolsa"."season_rules"."a_per_point" >= 0 and "futbolsa"."season_rules"."b_per_point" >= 0 and "futbolsa"."season_rules"."promotion_per_share" >= 0 and "futbolsa"."season_rules"."promotion_slots" >= 0 and "futbolsa"."season_rules"."buyback_multiple_bp" >= 0),
	CONSTRAINT "season_rules_placement_check" CHECK (0 <= all("futbolsa"."season_rules"."a_placement"))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."candles" (
	"club_id" integer NOT NULL,
	"interval" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"open" bigint NOT NULL,
	"high" bigint NOT NULL,
	"low" bigint NOT NULL,
	"close" bigint NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "candles_club_id_interval_start_pk" PRIMARY KEY("club_id","interval","start"),
	CONSTRAINT "candles_interval_check" CHECK ("futbolsa"."candles"."interval" in ('15m', '1d'))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."equity_daily" (
	"wallet_id" bigint NOT NULL,
	"day" date NOT NULL,
	"equity" bigint NOT NULL,
	CONSTRAINT "equity_daily_wallet_id_day_pk" PRIMARY KEY("wallet_id","day")
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."portfolio_snapshots" (
	"wallet_id" bigint NOT NULL,
	"month" text NOT NULL,
	"slices" jsonb NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	CONSTRAINT "portfolio_snapshots_wallet_id_month_pk" PRIMARY KEY("wallet_id","month"),
	CONSTRAINT "portfolio_snapshots_month_check" CHECK ("futbolsa"."portfolio_snapshots"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."positions" (
	"wallet_id" bigint NOT NULL,
	"club_id" integer NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"reserved_shares" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"realized" bigint DEFAULT 0 NOT NULL,
	"dividends" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "positions_wallet_id_club_id_pk" PRIMARY KEY("wallet_id","club_id"),
	CONSTRAINT "positions_shares_check" CHECK ("futbolsa"."positions"."shares" >= "futbolsa"."positions"."reserved_shares" and "futbolsa"."positions"."reserved_shares" >= 0),
	CONSTRAINT "positions_cost_check" CHECK ("futbolsa"."positions"."cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."wallet_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."wallet_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wallet_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"club_id" integer,
	"cash_delta" bigint DEFAULT 0 NOT NULL,
	"reserved_cash_delta" bigint DEFAULT 0 NOT NULL,
	"shares_delta" integer DEFAULT 0 NOT NULL,
	"reserved_shares_delta" integer DEFAULT 0 NOT NULL,
	"price" bigint,
	"realized" bigint,
	"cash_after" bigint NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"reason" text,
	CONSTRAINT "wallet_entries_kind_check" CHECK ("futbolsa"."wallet_entries"."kind" in ('initial', 'ipo_reserve', 'ipo_settle', 'index_entry', 'trade', 'order_reserve', 'order_release', 'dividend', 'reversal', 'complement', 'adjustment', 'buyback', 'season_close', 'account_deleted'))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."wallets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."wallets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"owner_type" text NOT NULL,
	"user_id" uuid,
	"bot_id" integer,
	"cash" bigint DEFAULT 0 NOT NULL,
	"reserved_cash" bigint DEFAULT 0 NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"entry_mode" text,
	"open_orders" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "wallets_owner_type_check" CHECK ("futbolsa"."wallets"."owner_type" in ('user', 'bot', 'treasury')),
	CONSTRAINT "wallets_owner_check" CHECK (("futbolsa"."wallets"."owner_type" = 'user' and "futbolsa"."wallets"."user_id" is not null and "futbolsa"."wallets"."bot_id" is null)
        or ("futbolsa"."wallets"."owner_type" = 'bot' and "futbolsa"."wallets"."bot_id" is not null and "futbolsa"."wallets"."user_id" is null)
        or ("futbolsa"."wallets"."owner_type" = 'treasury' and "futbolsa"."wallets"."user_id" is null and "futbolsa"."wallets"."bot_id" is null)),
	CONSTRAINT "wallets_entry_mode_check" CHECK ("futbolsa"."wallets"."entry_mode" is null or "futbolsa"."wallets"."entry_mode" in ('ipo', 'index', 'cash')),
	CONSTRAINT "wallets_reserved_cash_check" CHECK ("futbolsa"."wallets"."reserved_cash" >= 0),
	CONSTRAINT "wallets_cash_check" CHECK ("futbolsa"."wallets"."cash" >= "futbolsa"."wallets"."reserved_cash" or "futbolsa"."wallets"."reserved_cash" = 0),
	CONSTRAINT "wallets_open_orders_check" CHECK ("futbolsa"."wallets"."open_orders" >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."market_refresh_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."market_refresh_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"club_id" integer NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "market_refresh_requests_reason_check" CHECK ("futbolsa"."market_refresh_requests"."reason" in ('score', 'correction', 'close', 'resume'))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"club_id" integer NOT NULL,
	"wallet_id" bigint NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"quantity" integer NOT NULL,
	"filled" integer DEFAULT 0 NOT NULL,
	"limit_price" bigint,
	"reserved_cash" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"cancel_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	CONSTRAINT "orders_side_check" CHECK ("futbolsa"."orders"."side" in ('buy', 'sell')),
	CONSTRAINT "orders_type_check" CHECK ("futbolsa"."orders"."type" in ('limit', 'market')),
	CONSTRAINT "orders_status_check" CHECK ("futbolsa"."orders"."status" in ('open', 'filled', 'cancelled')),
	CONSTRAINT "orders_cancel_reason_check" CHECK ("futbolsa"."orders"."cancel_reason" is null or "futbolsa"."orders"."cancel_reason" in ('player', 'blocked', 'deleted', 'bot_off', 'reversal', 'trading_end', 'house_refresh', 'suspension', 'market_remainder')),
	CONSTRAINT "orders_quantity_check" CHECK ("futbolsa"."orders"."quantity" > 0 and "futbolsa"."orders"."filled" >= 0 and "futbolsa"."orders"."filled" <= "futbolsa"."orders"."quantity"),
	CONSTRAINT "orders_limit_price_check" CHECK (("futbolsa"."orders"."type" = 'limit' and "futbolsa"."orders"."limit_price" > 0) or ("futbolsa"."orders"."type" = 'market' and "futbolsa"."orders"."limit_price" is null)),
	CONSTRAINT "orders_reserved_cash_check" CHECK ("futbolsa"."orders"."reserved_cash" >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."trades" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."trades_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"club_id" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"price" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"buy_order_id" bigint NOT NULL,
	"sell_order_id" bigint NOT NULL,
	"buyer_wallet_id" bigint NOT NULL,
	"seller_wallet_id" bigint NOT NULL,
	"with_house" boolean DEFAULT false NOT NULL,
	CONSTRAINT "trades_values_check" CHECK ("futbolsa"."trades"."price" > 0 and "futbolsa"."trades"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."ipo_allocations" (
	"bid_id" bigint PRIMARY KEY NOT NULL,
	"shares" integer NOT NULL,
	"paid" bigint NOT NULL,
	"refunded" bigint NOT NULL,
	CONSTRAINT "ipo_allocations_values_check" CHECK ("futbolsa"."ipo_allocations"."shares" >= 0 and "futbolsa"."ipo_allocations"."paid" >= 0 and "futbolsa"."ipo_allocations"."refunded" >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."ipo_bids" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."ipo_bids_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"club_id" integer NOT NULL,
	"wallet_id" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"max_price" bigint NOT NULL,
	"reserved" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipo_bids_season_club_wallet_key" UNIQUE("season_id","club_id","wallet_id"),
	CONSTRAINT "ipo_bids_status_check" CHECK ("futbolsa"."ipo_bids"."status" in ('active', 'cancelled', 'settled')),
	CONSTRAINT "ipo_bids_values_check" CHECK ("futbolsa"."ipo_bids"."quantity" > 0 and "futbolsa"."ipo_bids"."max_price" > 0 and "futbolsa"."ipo_bids"."reserved" >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."ipo_results" (
	"season_id" integer NOT NULL,
	"club_id" integer NOT NULL,
	"cut_price" bigint NOT NULL,
	"demand_at_cut" integer NOT NULL,
	"allocation_num" bigint NOT NULL,
	"allocation_den" bigint NOT NULL,
	"treasury_shares" integer NOT NULL,
	"mm_lot_shares" integer NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ipo_results_season_id_club_id_pk" PRIMARY KEY("season_id","club_id"),
	CONSTRAINT "ipo_results_values_check" CHECK ("futbolsa"."ipo_results"."cut_price" > 0 and "futbolsa"."ipo_results"."allocation_den" > 0 and "futbolsa"."ipo_results"."treasury_shares" >= 0 and "futbolsa"."ipo_results"."mm_lot_shares" >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."payout_credits" (
	"event_id" bigint NOT NULL,
	"wallet_id" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"entry_id" bigint NOT NULL,
	CONSTRAINT "payout_credits_event_id_wallet_id_pk" PRIMARY KEY("event_id","wallet_id")
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."payout_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."payout_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"club_id" integer NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"competition" text,
	"round" integer,
	"phase" text,
	"per_share" bigint NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" bigint,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payout_events_kind_check" CHECK ("futbolsa"."payout_events"."kind" in ('points', 'placement', 'cup_phase', 'cup_title', 'promotion', 'buyback')),
	CONSTRAINT "payout_events_status_check" CHECK ("futbolsa"."payout_events"."status" in ('pending', 'approved', 'superseded')),
	CONSTRAINT "payout_events_competition_check" CHECK ("futbolsa"."payout_events"."competition" is null or "futbolsa"."payout_events"."competition" in ('brasileirao-a', 'brasileirao-b', 'copa-do-brasil', 'libertadores', 'sulamericana')),
	CONSTRAINT "payout_events_values_check" CHECK ("futbolsa"."payout_events"."per_share" >= 0 and "futbolsa"."payout_events"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."payout_holdings" (
	"event_id" bigint NOT NULL,
	"wallet_id" bigint NOT NULL,
	"shares" integer NOT NULL,
	CONSTRAINT "payout_holdings_event_id_wallet_id_pk" PRIMARY KEY("event_id","wallet_id"),
	CONSTRAINT "payout_holdings_shares_check" CHECK ("futbolsa"."payout_holdings"."shares" > 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."ranking_rows" (
	"snapshot_id" bigint NOT NULL,
	"wallet_id" bigint NOT NULL,
	"base" bigint NOT NULL,
	"equity" bigint NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "ranking_rows_snapshot_id_wallet_id_pk" PRIMARY KEY("snapshot_id","wallet_id"),
	CONSTRAINT "ranking_rows_values_check" CHECK ("futbolsa"."ranking_rows"."base" > 0 and "futbolsa"."ranking_rows"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."ranking_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."ranking_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"period" text NOT NULL,
	"period_key" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"bots_included" boolean NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ranking_snapshots_version_key" UNIQUE("season_id","period","period_key","version"),
	CONSTRAINT "ranking_snapshots_period_check" CHECK ("futbolsa"."ranking_snapshots"."period" in ('month', 'season'))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"status_code" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "futbolsa"."auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."invites" ADD CONSTRAINT "invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_results" ADD CONSTRAINT "season_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_results" ADD CONSTRAINT "season_results_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."admin_log" ADD CONSTRAINT "admin_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."matches" ADD CONSTRAINT "matches_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."matches" ADD CONSTRAINT "matches_home_club_id_clubs_id_fk" FOREIGN KEY ("home_club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."matches" ADD CONSTRAINT "matches_away_club_id_clubs_id_fk" FOREIGN KEY ("away_club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."matches" ADD CONSTRAINT "matches_advanced_club_id_clubs_id_fk" FOREIGN KEY ("advanced_club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_clubs" ADD CONSTRAINT "season_clubs_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_clubs" ADD CONSTRAINT "season_clubs_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."standings" ADD CONSTRAINT "standings_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."standings" ADD CONSTRAINT "standings_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."standings" ADD CONSTRAINT "standings_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."cup_phases" ADD CONSTRAINT "cup_phases_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_cups" ADD CONSTRAINT "season_cups_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_cups" ADD CONSTRAINT "season_cups_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_rules" ADD CONSTRAINT "season_rules_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."candles" ADD CONSTRAINT "candles_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."equity_daily" ADD CONSTRAINT "equity_daily_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."positions" ADD CONSTRAINT "positions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."positions" ADD CONSTRAINT "positions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."wallet_entries" ADD CONSTRAINT "wallet_entries_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."wallet_entries" ADD CONSTRAINT "wallet_entries_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."wallets" ADD CONSTRAINT "wallets_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."wallets" ADD CONSTRAINT "wallets_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "futbolsa"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."market_refresh_requests" ADD CONSTRAINT "market_refresh_requests_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."market_refresh_requests" ADD CONSTRAINT "market_refresh_requests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."orders" ADD CONSTRAINT "orders_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."orders" ADD CONSTRAINT "orders_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."orders" ADD CONSTRAINT "orders_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."trades" ADD CONSTRAINT "trades_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."trades" ADD CONSTRAINT "trades_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."trades" ADD CONSTRAINT "trades_buy_order_id_orders_id_fk" FOREIGN KEY ("buy_order_id") REFERENCES "futbolsa"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."trades" ADD CONSTRAINT "trades_sell_order_id_orders_id_fk" FOREIGN KEY ("sell_order_id") REFERENCES "futbolsa"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."trades" ADD CONSTRAINT "trades_buyer_wallet_id_wallets_id_fk" FOREIGN KEY ("buyer_wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."trades" ADD CONSTRAINT "trades_seller_wallet_id_wallets_id_fk" FOREIGN KEY ("seller_wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ipo_allocations" ADD CONSTRAINT "ipo_allocations_bid_id_ipo_bids_id_fk" FOREIGN KEY ("bid_id") REFERENCES "futbolsa"."ipo_bids"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ipo_bids" ADD CONSTRAINT "ipo_bids_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ipo_bids" ADD CONSTRAINT "ipo_bids_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ipo_bids" ADD CONSTRAINT "ipo_bids_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ipo_results" ADD CONSTRAINT "ipo_results_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ipo_results" ADD CONSTRAINT "ipo_results_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_credits" ADD CONSTRAINT "payout_credits_event_id_payout_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "futbolsa"."payout_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_credits" ADD CONSTRAINT "payout_credits_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_credits" ADD CONSTRAINT "payout_credits_entry_id_wallet_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "futbolsa"."wallet_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_events" ADD CONSTRAINT "payout_events_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_events" ADD CONSTRAINT "payout_events_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_events" ADD CONSTRAINT "payout_events_supersedes_id_payout_events_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "futbolsa"."payout_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_events" ADD CONSTRAINT "payout_events_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_holdings" ADD CONSTRAINT "payout_holdings_event_id_payout_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "futbolsa"."payout_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_holdings" ADD CONSTRAINT "payout_holdings_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ranking_rows" ADD CONSTRAINT "ranking_rows_snapshot_id_ranking_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "futbolsa"."ranking_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ranking_rows" ADD CONSTRAINT "ranking_rows_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."ranking_snapshots" ADD CONSTRAINT "ranking_snapshots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "futbolsa"."users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_nickname_lower_key" ON "futbolsa"."users" USING btree (lower("nickname"));--> statement-breakpoint
CREATE INDEX "admin_log_at_idx" ON "futbolsa"."admin_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "matches_season_kickoff_idx" ON "futbolsa"."matches" USING btree ("season_id","kickoff");--> statement-breakpoint
CREATE INDEX "wallet_entries_wallet_club_at_idx" ON "futbolsa"."wallet_entries" USING btree ("wallet_id","club_id","at");--> statement-breakpoint
CREATE INDEX "wallet_entries_wallet_at_idx" ON "futbolsa"."wallet_entries" USING btree ("wallet_id","at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_season_user_key" ON "futbolsa"."wallets" USING btree ("season_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_season_bot_key" ON "futbolsa"."wallets" USING btree ("season_id","bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallets_season_treasury_key" ON "futbolsa"."wallets" USING btree ("season_id") WHERE "futbolsa"."wallets"."owner_type" = 'treasury';--> statement-breakpoint
CREATE INDEX "market_refresh_requests_pending_idx" ON "futbolsa"."market_refresh_requests" USING btree ("club_id") WHERE "futbolsa"."market_refresh_requests"."done_at" is null;--> statement-breakpoint
CREATE INDEX "orders_book_idx" ON "futbolsa"."orders" USING btree ("club_id","side","limit_price","id") WHERE "futbolsa"."orders"."status" = 'open';--> statement-breakpoint
CREATE INDEX "orders_wallet_open_idx" ON "futbolsa"."orders" USING btree ("wallet_id") WHERE "futbolsa"."orders"."status" = 'open';--> statement-breakpoint
CREATE INDEX "orders_wallet_created_idx" ON "futbolsa"."orders" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_club_at_idx" ON "futbolsa"."trades" USING btree ("club_id","at");--> statement-breakpoint
CREATE INDEX "trades_season_at_idx" ON "futbolsa"."trades" USING btree ("season_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "payout_events_current_key" ON "futbolsa"."payout_events" USING btree ("season_id","club_id","event_key") WHERE "futbolsa"."payout_events"."status" <> 'superseded';--> statement-breakpoint
CREATE INDEX "payout_events_season_status_idx" ON "futbolsa"."payout_events" USING btree ("season_id","status");