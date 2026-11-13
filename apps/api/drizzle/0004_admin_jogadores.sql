CREATE TABLE "futbolsa"."player_notices" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."player_notices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	"email_sent_at" timestamp with time zone,
	"email_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "player_notices_kind_check" CHECK ("futbolsa"."player_notices"."kind" in ('fraud_warning', 'fraud_ban'))
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."trade_annulments" (
	"trade_id" bigint PRIMARY KEY NOT NULL,
	"case_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"shares_returned" integer DEFAULT 0 NOT NULL,
	"cash_returned" bigint DEFAULT 0 NOT NULL,
	"shares_short" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "trade_annulments_values_check" CHECK ("futbolsa"."trade_annulments"."shares_returned" >= 0 and "futbolsa"."trade_annulments"."shares_short" >= 0)
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."fraud_case_trades" (
	"case_id" bigint NOT NULL,
	"trade_id" bigint NOT NULL,
	"suspicious" boolean DEFAULT false NOT NULL,
	"selected" boolean DEFAULT false NOT NULL,
	CONSTRAINT "fraud_case_trades_case_id_trade_id_pk" PRIMARY KEY("case_id","trade_id")
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."fraud_cases" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."fraud_cases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"wallet_low" bigint NOT NULL,
	"wallet_high" bigint NOT NULL,
	"club_id" integer,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"opened_by" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"report" jsonb,
	"report_hash" text,
	CONSTRAINT "fraud_cases_origin_check" CHECK ("futbolsa"."fraud_cases"."origin" in ('alert', 'manual')),
	CONSTRAINT "fraud_cases_status_check" CHECK ("futbolsa"."fraud_cases"."status" in ('open', 'confirmed', 'dismissed')),
	CONSTRAINT "fraud_cases_pair_check" CHECK ("futbolsa"."fraud_cases"."wallet_low" < "futbolsa"."fraud_cases"."wallet_high"),
	CONSTRAINT "fraud_cases_period_check" CHECK ("futbolsa"."fraud_cases"."period_from" <= "futbolsa"."fraud_cases"."period_to")
);
--> statement-breakpoint
CREATE TABLE "futbolsa"."fraud_warnings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."fraud_warnings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"season_id" integer NOT NULL,
	"case_id" bigint NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "futbolsa"."wallet_entries" DROP CONSTRAINT "wallet_entries_kind_check";--> statement-breakpoint
ALTER TABLE "futbolsa"."orders" DROP CONSTRAINT "orders_cancel_reason_check";--> statement-breakpoint
ALTER TABLE "futbolsa"."player_notices" ADD CONSTRAINT "player_notices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."trade_annulments" ADD CONSTRAINT "trade_annulments_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "futbolsa"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_case_trades" ADD CONSTRAINT "fraud_case_trades_case_id_fraud_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "futbolsa"."fraud_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_case_trades" ADD CONSTRAINT "fraud_case_trades_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "futbolsa"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_cases" ADD CONSTRAINT "fraud_cases_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_cases" ADD CONSTRAINT "fraud_cases_wallet_low_wallets_id_fk" FOREIGN KEY ("wallet_low") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_cases" ADD CONSTRAINT "fraud_cases_wallet_high_wallets_id_fk" FOREIGN KEY ("wallet_high") REFERENCES "futbolsa"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_cases" ADD CONSTRAINT "fraud_cases_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_cases" ADD CONSTRAINT "fraud_cases_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_cases" ADD CONSTRAINT "fraud_cases_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_warnings" ADD CONSTRAINT "fraud_warnings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_warnings" ADD CONSTRAINT "fraud_warnings_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."fraud_warnings" ADD CONSTRAINT "fraud_warnings_case_id_fraud_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "futbolsa"."fraud_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_notices_user_unread_idx" ON "futbolsa"."player_notices" USING btree ("user_id") WHERE "futbolsa"."player_notices"."read_at" is null;--> statement-breakpoint
CREATE INDEX "player_notices_mail_idx" ON "futbolsa"."player_notices" USING btree ("id") WHERE "futbolsa"."player_notices"."email_sent_at" is null;--> statement-breakpoint
CREATE INDEX "fraud_case_trades_trade_idx" ON "futbolsa"."fraud_case_trades" USING btree ("trade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_cases_open_alert_key" ON "futbolsa"."fraud_cases" USING btree ("season_id","club_id","wallet_low","wallet_high") WHERE "futbolsa"."fraud_cases"."origin" = 'alert' and "futbolsa"."fraud_cases"."status" = 'open';--> statement-breakpoint
CREATE INDEX "fraud_cases_season_status_idx" ON "futbolsa"."fraud_cases" USING btree ("season_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fraud_warnings_user_case_key" ON "futbolsa"."fraud_warnings" USING btree ("user_id","case_id");--> statement-breakpoint
CREATE INDEX "fraud_warnings_user_season_idx" ON "futbolsa"."fraud_warnings" USING btree ("user_id","season_id");--> statement-breakpoint
CREATE INDEX "trades_buyer_at_idx" ON "futbolsa"."trades" USING btree ("buyer_wallet_id","at","id");--> statement-breakpoint
CREATE INDEX "trades_seller_at_idx" ON "futbolsa"."trades" USING btree ("seller_wallet_id","at","id");--> statement-breakpoint
ALTER TABLE "futbolsa"."wallet_entries" ADD CONSTRAINT "wallet_entries_kind_check" CHECK ("futbolsa"."wallet_entries"."kind" in ('initial', 'ipo_reserve', 'ipo_settle', 'index_entry', 'trade', 'order_reserve', 'order_release', 'dividend', 'reversal', 'complement', 'adjustment', 'buyback', 'season_close', 'account_deleted', 'trade_annulled'));--> statement-breakpoint
ALTER TABLE "futbolsa"."orders" ADD CONSTRAINT "orders_cancel_reason_check" CHECK ("futbolsa"."orders"."cancel_reason" is null or "futbolsa"."orders"."cancel_reason" in ('player', 'blocked', 'deleted', 'bot_off', 'reversal', 'trading_end', 'house_refresh', 'suspension', 'market_remainder', 'annulment'));
--> statement-breakpoint
-- Negócio anulado é histórico: não se edita nem se apaga (F14, trapaça entre contas).
CREATE TRIGGER "trade_annulments_history" BEFORE UPDATE OR DELETE OR TRUNCATE ON "futbolsa"."trade_annulments"
  FOR EACH STATEMENT EXECUTE FUNCTION "futbolsa"."forbid_history_change"();
