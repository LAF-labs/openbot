CREATE TABLE "computer_repeat_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computer_repeat_reports" (
	"bot_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"threshold" integer NOT NULL,
	CONSTRAINT "computer_repeat_reports_bot_id_fingerprint_threshold_pk" PRIMARY KEY("bot_id","fingerprint","threshold")
);
--> statement-breakpoint
CREATE INDEX "computer_repeat_calls_lookup" ON "computer_repeat_calls" USING btree ("bot_id","fingerprint","at");