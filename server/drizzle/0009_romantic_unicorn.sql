CREATE TABLE "laf_routine_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"answer" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "laf_routines" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"instruction" text NOT NULL,
	"schedule_kind" text NOT NULL,
	"interval_minutes" integer,
	"daily_utc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_id" text NOT NULL,
	"created_by_role" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
