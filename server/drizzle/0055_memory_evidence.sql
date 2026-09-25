CREATE TABLE "agent_guidance" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"content" text NOT NULL,
	"source" text DEFAULT 'dream' NOT NULL,
	"day" text,
	"forgotten_at" timestamp with time zone,
	"forgotten_by" text,
	"replaced_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"job" text NOT NULL,
	"checked" integer DEFAULT 0 NOT NULL,
	"confirmed" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"superseded" integer DEFAULT 0 NOT NULL,
	"scrubbed" integer DEFAULT 0 NOT NULL,
	"arm" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "evidence_thread_id" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "evidence_message_id" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "evidence_excerpt" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "curated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "confidence" real;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "supersedes" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "forgotten_by" text;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN "forget_reason" text;--> statement-breakpoint
ALTER TABLE "agent_guidance" ADD CONSTRAINT "agent_guidance_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_guidance" ADD CONSTRAINT "agent_guidance_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_receipts" ADD CONSTRAINT "agent_memory_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_receipts" ADD CONSTRAINT "agent_memory_receipts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_guidance_agent_owner_idx" ON "agent_guidance" USING btree ("agent_id","owner_user_id","forgotten_at");--> statement-breakpoint
CREATE INDEX "agent_memory_receipts_agent_owner_idx" ON "agent_memory_receipts" USING btree ("agent_id","owner_user_id","created_at");