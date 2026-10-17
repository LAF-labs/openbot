CREATE TABLE "hub_job_routines" (
	"job_id" text PRIMARY KEY NOT NULL,
	"routine_id" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_job_routines_routine_id_unique" UNIQUE("routine_id")
);
--> statement-breakpoint
CREATE TABLE "hub_task_asks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"rule" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_value" text NOT NULL,
	"subject" jsonb,
	"topic" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone,
	"granted_by" text
);
--> statement-breakpoint
ALTER TABLE "hub_job_routines" ADD CONSTRAINT "hub_job_routines_routine_id_laf_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."laf_routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_task_asks" ADD CONSTRAINT "hub_task_asks_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;