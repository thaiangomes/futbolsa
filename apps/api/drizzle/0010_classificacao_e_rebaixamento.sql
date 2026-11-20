CREATE TABLE "futbolsa"."season_qualifications" (
	"season_id" integer NOT NULL,
	"club_id" integer NOT NULL,
	"cup" text NOT NULL,
	CONSTRAINT "season_qualifications_season_id_club_id_cup_pk" PRIMARY KEY("season_id","club_id","cup"),
	CONSTRAINT "season_qualifications_cup_check" CHECK ("futbolsa"."season_qualifications"."cup" in ('libertadores', 'sulamericana'))
);
--> statement-breakpoint
ALTER TABLE "futbolsa"."season_rules" DROP CONSTRAINT "season_rules_values_check";--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_events" DROP CONSTRAINT "payout_events_kind_check";--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_events" DROP CONSTRAINT "payout_events_values_check";--> statement-breakpoint
ALTER TABLE "futbolsa"."season_rules" ADD COLUMN "a_libertadores_bonus" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_rules" ADD COLUMN "a_sulamericana_bonus" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_rules" ADD COLUMN "a_relegation_penalty" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_rules" ADD COLUMN "a_relegation_slots" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_qualifications" ADD CONSTRAINT "season_qualifications_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_qualifications" ADD CONSTRAINT "season_qualifications_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."season_rules" ADD CONSTRAINT "season_rules_values_check" CHECK ("futbolsa"."season_rules"."a_per_point" >= 0 and "futbolsa"."season_rules"."b_per_point" >= 0 and "futbolsa"."season_rules"."promotion_per_share" >= 0 and "futbolsa"."season_rules"."promotion_slots" >= 0 and "futbolsa"."season_rules"."buyback_multiple_bp" >= 0 and "futbolsa"."season_rules"."a_libertadores_bonus" >= 0 and "futbolsa"."season_rules"."a_sulamericana_bonus" >= 0 and "futbolsa"."season_rules"."a_relegation_penalty" >= 0 and "futbolsa"."season_rules"."a_relegation_slots" between 0 and 20);--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_events" ADD CONSTRAINT "payout_events_kind_check" CHECK ("futbolsa"."payout_events"."kind" in ('points', 'placement', 'qualification', 'relegation', 'cup_phase', 'cup_title', 'promotion', 'buyback'));--> statement-breakpoint
ALTER TABLE "futbolsa"."payout_events" ADD CONSTRAINT "payout_events_values_check" CHECK (("futbolsa"."payout_events"."per_share" >= 0 or "futbolsa"."payout_events"."kind" = 'relegation') and "futbolsa"."payout_events"."version" >= 1);