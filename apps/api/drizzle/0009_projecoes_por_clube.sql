CREATE TABLE "futbolsa"."club_projections" (
	"season_id" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"club_id" integer NOT NULL,
	"points" integer NOT NULL,
	"position" integer NOT NULL,
	"cups" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "club_projections_season_id_user_id_club_id_pk" PRIMARY KEY("season_id","user_id","club_id"),
	CONSTRAINT "club_projections_points_check" CHECK ("futbolsa"."club_projections"."points" between 0 and 114),
	CONSTRAINT "club_projections_position_check" CHECK ("futbolsa"."club_projections"."position" between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "futbolsa"."club_projections" ADD CONSTRAINT "club_projections_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."club_projections" ADD CONSTRAINT "club_projections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "futbolsa"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "futbolsa"."club_projections" ADD CONSTRAINT "club_projections_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "futbolsa"."clubs"("id") ON DELETE no action ON UPDATE no action;