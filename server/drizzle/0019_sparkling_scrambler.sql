CREATE TYPE "public"."agent_effort" AS ENUM('quick', 'balanced', 'thorough');--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "effort" "agent_effort" DEFAULT 'balanced' NOT NULL;