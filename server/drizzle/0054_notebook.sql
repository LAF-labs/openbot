ALTER TABLE "agent_memories" ADD COLUMN "source" text DEFAULT 'bot' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "replaced_by" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "slot" text;