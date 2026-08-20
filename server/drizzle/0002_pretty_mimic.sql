CREATE TABLE "laf_thread_runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"agent_id" text,
	"status" text NOT NULL,
	"error" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "laf_thread_snapshots" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"agent_id" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
