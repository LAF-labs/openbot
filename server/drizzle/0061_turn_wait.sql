ALTER TABLE "laf_thread_runs" ADD COLUMN "first_sign_ms" integer;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "first_word_ms" integer;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "first_move_asked" text[];--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "first_move_verdict" text;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "first_move_kind" text;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "first_move_decision_ms" integer;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD COLUMN "first_move_call_ms" integer;