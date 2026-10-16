CREATE TABLE "hub_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"flat" text NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_run" text,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence" jsonb NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"retired_by" text,
	"retired_at" timestamp with time zone,
	"pushed_out_at" timestamp with time zone,
	CONSTRAINT "hub_memory_state" CHECK ("hub_memory"."state" in ('proposed', 'confirmed', 'retired')),
	CONSTRAINT "hub_memory_content" CHECK (char_length("hub_memory"."content") <= 400)
);
--> statement-breakpoint
CREATE TABLE "hub_skills" (
	"slug" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"instructions" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"profile" text,
	"shipped_version" text,
	"shipped_hash" text
);
--> statement-breakpoint
CREATE TABLE "hub_versions" (
	"kind" text PRIMARY KEY NOT NULL,
	"version" bigint NOT NULL,
	CONSTRAINT "hub_versions_kind" CHECK ("hub_versions"."kind" in ('skills', 'memory'))
);
--> statement-breakpoint
ALTER TABLE "hub_events" ADD COLUMN "version" bigint;--> statement-breakpoint
ALTER TABLE "hub_memory" ADD CONSTRAINT "hub_memory_proposed_by_hub_members_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_memory" ADD CONSTRAINT "hub_memory_confirmed_by_hub_members_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_memory" ADD CONSTRAINT "hub_memory_retired_by_hub_members_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_skills" ADD CONSTRAINT "hub_skills_created_by_hub_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_skills" ADD CONSTRAINT "hub_skills_updated_by_hub_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_memory_state_flat" ON "hub_memory" USING btree ("state","flat");