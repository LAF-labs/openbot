CREATE TYPE "public"."laf_run_ending" AS ENUM('finished', 'unfinished', 'stopped', 'owner');--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "ending" "laf_run_ending";--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "ending_code" text;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "queued_ms" integer;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "first_token_ms" integer;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "stream_ms" integer;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "total_ms" integer;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "model_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "tool_calls" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "approvals_asked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "approvals_granted" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "prompt_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "cached_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "cost_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "laf_thread_runs_thread_idx" ON "laf_thread_runs" USING btree ("thread_id","started_at");