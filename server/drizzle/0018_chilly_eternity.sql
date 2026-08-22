CREATE TABLE "computer_standing_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"rule" text NOT NULL,
	"scope" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_value" text NOT NULL,
	"question" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "computer_approvals" ADD COLUMN "scope_kind" text;--> statement-breakpoint
ALTER TABLE "computer_approvals" ADD COLUMN "scope_value" text;--> statement-breakpoint
CREATE UNIQUE INDEX "computer_standing_approvals_live_idx" ON "computer_standing_approvals" USING btree ("bot_id","rule","scope") WHERE "computer_standing_approvals"."revoked_at" is null;