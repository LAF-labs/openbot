-- A third answer between "this once" and "always": for this conversation, 2026-09-06.
--
-- A standing allowance was the only way past being asked again, and it never ends on its own. A
-- person clearing an obstacle for the afternoon had to choose between pressing Allow twenty times
-- and standing the boundary down for good. So an allowance can now be bound to one thread and to a
-- clock: `thread_id` says which conversation it answers for, `expires_at` says when it stops on its
-- own (a day after the grant), and both are null for the standing kind, whose rows are unchanged.
--
-- The live index gains the thread, coalesced: NULL never equals NULL in SQL, so an index that named
-- the column directly would have let two standing grants for the same question both stand.

DROP INDEX "computer_standing_approvals_live_idx";--> statement-breakpoint
ALTER TABLE "computer_standing_approvals" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "computer_standing_approvals" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "computer_standing_approvals_live_idx" ON "computer_standing_approvals" USING btree ("bot_id","rule","scope",coalesce("thread_id", '')) WHERE "computer_standing_approvals"."revoked_at" is null;
