CREATE TABLE "hub_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"member" text,
	"vm_origin" text,
	"action" text NOT NULL,
	"target" text,
	"run_id" text,
	"outcome" text,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "hub_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"ref_id" text,
	"actor" text,
	"visible_to" text[],
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_idempotency" (
	"member" text NOT NULL,
	"key" text NOT NULL,
	"status" integer NOT NULL,
	"body" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_idempotency_member_key_pk" PRIMARY KEY("member","key")
);
--> statement-breakpoint
CREATE TABLE "hub_members" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"name" text,
	"vm_origin" text,
	"vm_key_hash" text,
	"prev_key_hash" text,
	"prev_key_until" timestamp with time zone,
	"state" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "hub_members_email_unique" UNIQUE("email"),
	CONSTRAINT "hub_members_vm_origin_unique" UNIQUE("vm_origin"),
	CONSTRAINT "hub_members_vm_key_hash_unique" UNIQUE("vm_key_hash"),
	CONSTRAINT "hub_members_role" CHECK ("hub_members"."role" in ('owner', 'admin', 'member')),
	CONSTRAINT "hub_members_state" CHECK ("hub_members"."state" in ('active', 'left'))
);
--> statement-breakpoint
CREATE TABLE "hub_workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"one" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"plan" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_workspace_one_unique" UNIQUE("one"),
	CONSTRAINT "hub_workspace_one" CHECK ("hub_workspace"."one")
);
--> statement-breakpoint
ALTER TABLE "hub_events" ADD CONSTRAINT "hub_events_actor_hub_members_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."hub_members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hub_audit_at" ON "hub_audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX "hub_idempotency_at" ON "hub_idempotency" USING btree ("at");--> statement-breakpoint
CREATE INDEX "hub_members_prev_key_hash" ON "hub_members" USING btree ("prev_key_hash");--> statement-breakpoint
-- The trail refuses to be edited, the way the product's `audit_events` does (its 0000 and 0028):
-- a trail that can be rewritten answers nothing about what happened. Written by hand beside the
-- generated tables, since drizzle-kit has no word for a trigger. TRUNCATE too, which a row trigger
-- never sees. No maintenance exit yet: retention arrives with the change that needs it, as a named
-- function that says which maintenance it performs.
CREATE OR REPLACE FUNCTION hub_audit_refuse_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'hub_audit is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER hub_audit_append_only
BEFORE UPDATE OR DELETE ON hub_audit
FOR EACH ROW EXECUTE FUNCTION hub_audit_refuse_change();--> statement-breakpoint
CREATE TRIGGER hub_audit_no_truncate
BEFORE TRUNCATE ON hub_audit
FOR EACH STATEMENT EXECUTE FUNCTION hub_audit_refuse_change();
