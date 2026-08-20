CREATE TABLE "laf_digest_log" (
	"id" text PRIMARY KEY NOT NULL,
	"for_date" text NOT NULL,
	"channel" text NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"headline" text NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
