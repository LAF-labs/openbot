CREATE TABLE "hub_cursor" (
	"one" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"hub" text NOT NULL,
	"seq" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hub_cursor_one" CHECK ("hub_cursor"."one")
);
--> statement-breakpoint
CREATE TABLE "hub_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"body" jsonb,
	"origin" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_tried_at" timestamp with time zone,
	"last_code" text,
	"delivered_at" timestamp with time zone,
	"refused_at" timestamp with time zone,
	"status" integer
);
--> statement-breakpoint
CREATE INDEX "hub_outbox_pending_idx" ON "hub_outbox" USING btree ("created_at") WHERE "hub_outbox"."delivered_at" is null and "hub_outbox"."refused_at" is null;