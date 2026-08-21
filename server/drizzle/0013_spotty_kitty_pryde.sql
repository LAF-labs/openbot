ALTER TABLE "laf_thread_runs" ALTER COLUMN "thread_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "label" text;--> statement-breakpoint
CREATE INDEX "laf_thread_runs_live_idx" ON "laf_thread_runs" USING btree ("user_id","started_at") WHERE "laf_thread_runs"."status" = 'running';