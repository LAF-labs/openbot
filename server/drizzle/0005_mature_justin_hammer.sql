ALTER TABLE "mcp_tools" ADD COLUMN "annotations" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "definition_hash" text;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD COLUMN "review_reason" text;