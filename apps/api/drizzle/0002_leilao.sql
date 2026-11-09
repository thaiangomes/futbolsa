ALTER TABLE "futbolsa"."season_clubs" ADD COLUMN "tunnel_ref" bigint;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_clubs" ADD COLUMN "tunnel_ref_day" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_clubs" ADD COLUMN "auction_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_clubs" ADD COLUMN "auction_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "futbolsa"."trades" ADD COLUMN "price_before" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "futbolsa"."trades" ADD COLUMN "in_auction" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_clubs" ADD CONSTRAINT "season_clubs_tunnel_ref_check" CHECK ("futbolsa"."season_clubs"."tunnel_ref" is null or "futbolsa"."season_clubs"."tunnel_ref" > 0);--> statement-breakpoint
ALTER TABLE "futbolsa"."season_clubs" ADD CONSTRAINT "season_clubs_auction_check" CHECK ("futbolsa"."season_clubs"."auction_until" is null or "futbolsa"."season_clubs"."auction_opened_at" is not null);