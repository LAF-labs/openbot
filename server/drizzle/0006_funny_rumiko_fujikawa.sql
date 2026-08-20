ALTER TABLE "laf_thread_runs" ADD COLUMN "origin" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD CONSTRAINT "laf_thread_runs_dedupe_key_unique" UNIQUE("dedupe_key");