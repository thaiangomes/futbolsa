CREATE TABLE "futbolsa"."ranking_recalc_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "futbolsa"."ranking_recalc_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"season_id" integer NOT NULL,
	"from_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "futbolsa"."ranking_rows" DROP CONSTRAINT "ranking_rows_values_check";--> statement-breakpoint
ALTER TABLE "futbolsa"."ranking_recalc_requests" ADD CONSTRAINT "ranking_recalc_requests_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "futbolsa"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ranking_recalc_requests_open_key" ON "futbolsa"."ranking_recalc_requests" USING btree ("season_id") WHERE "futbolsa"."ranking_recalc_requests"."done_at" is null;--> statement-breakpoint
CREATE INDEX "ranking_recalc_requests_season_idx" ON "futbolsa"."ranking_recalc_requests" USING btree ("season_id");--> statement-breakpoint
ALTER TABLE "futbolsa"."ranking_rows" ADD CONSTRAINT "ranking_rows_values_check" CHECK ("futbolsa"."ranking_rows"."base" is not null and "futbolsa"."ranking_rows"."position" >= 1);