DROP INDEX "computer_standing_approvals_live_idx";--> statement-breakpoint
ALTER TABLE "computer_standing_approvals" ADD COLUMN "tier" text DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_standing_approvals" ADD COLUMN "task_id" text;--> statement-breakpoint
UPDATE "computer_standing_approvals" SET "tier" = 'thread' WHERE "thread_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "computer_standing_approvals_live_idx" ON "computer_standing_approvals" USING btree ("bot_id","rule","scope","tier",coalesce("thread_id", ''),coalesce("task_id", '')) WHERE "computer_standing_approvals"."revoked_at" is null;