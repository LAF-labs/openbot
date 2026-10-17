-- `hub_task_members` is also made by the files change (its 0001_hub_files.sql), which reads it for
-- `task:` visibility. The two changes were written side by side, so whichever runs second finds
-- the table made, with the same columns, key, foreign key and index: every statement about it
-- here is written to do nothing when that is so. Edited by hand after `drizzle-kit generate`.
CREATE TABLE IF NOT EXISTS "hub_task_members" (
	"task_id" text NOT NULL,
	"member_id" text NOT NULL,
	CONSTRAINT "hub_task_members_task_id_member_id_pk" PRIMARY KEY("task_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "hub_task_notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"by" text NOT NULL,
	"text" text NOT NULL,
	"run_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"stage" text DEFAULT 'todo' NOT NULL,
	"visibility" text DEFAULT 'company' NOT NULL,
	"assignee" text,
	"assigned_by" text,
	"created_by" text,
	"checkout_run_id" text,
	"checkout_by" text,
	"lock_expires_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"rank" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "hub_tasks_stage" CHECK ("hub_tasks"."stage" in ('todo', 'doing', 'review', 'blocked', 'done')),
	CONSTRAINT "hub_tasks_visibility" CHECK ("hub_tasks"."visibility" = 'company' or "hub_tasks"."visibility" like 'me:_%' or "hub_tasks"."visibility" like 'task:_%'),
	CONSTRAINT "hub_tasks_assignee" CHECK ("hub_tasks"."assignee" is null or "hub_tasks"."assignee" like 'm:_%' or "hub_tasks"."assignee" like 'bot:_%' or "hub_tasks"."assignee" like 'job:_%'),
	CONSTRAINT "hub_tasks_checkout" CHECK (("hub_tasks"."checkout_run_id" is null) = ("hub_tasks"."lock_expires_at" is null) and ("hub_tasks"."checkout_run_id" is null) = ("hub_tasks"."checkout_by" is null))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hub_task_members_member_id_hub_members_id_fk') THEN
    ALTER TABLE "hub_task_members" ADD CONSTRAINT "hub_task_members_member_id_hub_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "hub_task_notes" ADD CONSTRAINT "hub_task_notes_task_id_hub_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."hub_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_tasks" ADD CONSTRAINT "hub_tasks_assigned_by_hub_members_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_tasks" ADD CONSTRAINT "hub_tasks_created_by_hub_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_tasks" ADD CONSTRAINT "hub_tasks_checkout_by_hub_members_id_fk" FOREIGN KEY ("checkout_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_task_members_member" ON "hub_task_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "hub_task_notes_task" ON "hub_task_notes" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "hub_tasks_created" ON "hub_tasks" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "hub_tasks_lock" ON "hub_tasks" USING btree ("lock_expires_at") WHERE "hub_tasks"."checkout_run_id" is not null;