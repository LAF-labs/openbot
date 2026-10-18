CREATE TABLE "hub_job_handoffs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"from_member" text NOT NULL,
	"to_member" text NOT NULL,
	"body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_tasks" ADD COLUMN "blocked_by" text;--> statement-breakpoint
ALTER TABLE "hub_job_handoffs" ADD CONSTRAINT "hub_job_handoffs_job_id_hub_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."hub_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_job_handoffs" ADD CONSTRAINT "hub_job_handoffs_from_member_hub_members_id_fk" FOREIGN KEY ("from_member") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_job_handoffs" ADD CONSTRAINT "hub_job_handoffs_to_member_hub_members_id_fk" FOREIGN KEY ("to_member") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_job_handoffs_expires" ON "hub_job_handoffs" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "hub_tasks" ADD CONSTRAINT "hub_tasks_blocked_by_hub_members_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;