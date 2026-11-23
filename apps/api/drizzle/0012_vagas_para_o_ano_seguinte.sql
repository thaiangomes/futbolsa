CREATE TABLE "futbolsa"."season_slots" (
	"season_id" integer PRIMARY KEY NOT NULL,
	"rules" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "futbolsa"."season_slots" ADD CONSTRAINT "season_slots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;