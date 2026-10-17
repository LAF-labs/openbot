CREATE TABLE "hub_budget_entries" (
	"member" text NOT NULL,
	"run_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"reserved" numeric(14, 6) NOT NULL,
	"actual" numeric(14, 6),
	"state" text NOT NULL,
	"day" date NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	CONSTRAINT "hub_budget_entries_member_run_id_pk" PRIMARY KEY("member","run_id"),
	CONSTRAINT "hub_budget_entries_state" CHECK ("hub_budget_entries"."state" in ('reserved', 'settled', 'expired')),
	CONSTRAINT "hub_budget_entries_settled" CHECK (("hub_budget_entries"."state" = 'settled') = ("hub_budget_entries"."actual" is not null)),
	CONSTRAINT "hub_budget_entries_amounts" CHECK ("hub_budget_entries"."reserved" >= 0 and ("hub_budget_entries"."actual" is null or "hub_budget_entries"."actual" >= 0))
);
--> statement-breakpoint
CREATE TABLE "hub_budget_limits" (
	"scope_kind" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"daily_usd" numeric(14, 6) NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_budget_limits_scope_kind_scope_id_pk" PRIMARY KEY("scope_kind","scope_id"),
	CONSTRAINT "hub_budget_limits_kind" CHECK ("hub_budget_limits"."scope_kind" in ('workspace', 'job', 'task')),
	CONSTRAINT "hub_budget_limits_id" CHECK (("hub_budget_limits"."scope_kind" = 'workspace') = ("hub_budget_limits"."scope_id" = '')),
	CONSTRAINT "hub_budget_limits_usd" CHECK ("hub_budget_limits"."daily_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "hub_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"runner" text NOT NULL,
	"schedule" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_budget_entries" ADD CONSTRAINT "hub_budget_entries_member_hub_members_id_fk" FOREIGN KEY ("member") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_budget_limits" ADD CONSTRAINT "hub_budget_limits_updated_by_hub_members_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_jobs" ADD CONSTRAINT "hub_jobs_owner_hub_members_id_fk" FOREIGN KEY ("owner") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_jobs" ADD CONSTRAINT "hub_jobs_runner_hub_members_id_fk" FOREIGN KEY ("runner") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_jobs" ADD CONSTRAINT "hub_jobs_created_by_hub_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_budget_entries_day" ON "hub_budget_entries" USING btree ("day");--> statement-breakpoint
CREATE INDEX "hub_budget_entries_open" ON "hub_budget_entries" USING btree ("reserved_at") WHERE "hub_budget_entries"."state" = 'reserved';--> statement-breakpoint
CREATE INDEX "hub_jobs_runner" ON "hub_jobs" USING btree ("runner");--> statement-breakpoint
CREATE INDEX "hub_events_budget_reached" ON "hub_events" USING btree ("ref_id","at") WHERE "hub_events"."type" = 'budget.reached';