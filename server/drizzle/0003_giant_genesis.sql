CREATE TABLE "laf_watch_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"key" text NOT NULL,
	"prev_status" text,
	"next_status" text,
	"detail" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "laf_watch_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"wake_agent_id" text,
	"last_signals" jsonb,
	"last_polled_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "laf_watch_events" ADD CONSTRAINT "laf_watch_events_source_id_laf_watch_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."laf_watch_sources"("id") ON DELETE cascade ON UPDATE no action;