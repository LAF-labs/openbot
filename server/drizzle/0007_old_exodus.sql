CREATE TABLE "computer_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"bot_id" text NOT NULL,
	"actor" text NOT NULL,
	"rule" text,
	"question" text NOT NULL,
	"fingerprint" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted" boolean,
	"answered_by" text
);
