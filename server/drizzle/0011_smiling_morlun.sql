ALTER TABLE "agent_preferences" ADD COLUMN "pinned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_preferences" ADD COLUMN "notify" boolean DEFAULT true NOT NULL;