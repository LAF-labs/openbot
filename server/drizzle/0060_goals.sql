CREATE TABLE "laf_goal_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"goal_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'check_in' NOT NULL,
	"text" text NOT NULL,
	"value" double precision,
	"momentum" text,
	"source" text DEFAULT 'bot' NOT NULL,
	"run_id" text
);
--> statement-breakpoint
CREATE TABLE "laf_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"target" text NOT NULL,
	"measure" jsonb,
	"due_on" text,
	"status" text DEFAULT 'active' NOT NULL,
	"momentum" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "laf_routines" ADD COLUMN "goal_id" text;--> statement-breakpoint
ALTER TABLE "laf_goal_entries" ADD CONSTRAINT "laf_goal_entries_goal_id_laf_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."laf_goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_goals" ADD CONSTRAINT "laf_goals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_goals" ADD CONSTRAINT "laf_goals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "laf_goal_entries_goal_at_idx" ON "laf_goal_entries" USING btree ("goal_id","at");--> statement-breakpoint
CREATE INDEX "laf_goals_user_status_idx" ON "laf_goals" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "laf_routines" ADD CONSTRAINT "laf_routines_goal_id_laf_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."laf_goals"("id") ON DELETE set null ON UPDATE no action;