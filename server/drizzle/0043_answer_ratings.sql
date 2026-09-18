-- 좋아요·아쉬워요 under a Bot's answer: how the person found one reply, 2026-09-18.
--
-- One row per person per answer — a second press replaces the first (the unique index) — holding
-- which answer (its id in the person's own thread), which Bot gave it, which way they pressed, and
-- for 아쉬워요 a reason key and an optional note. Never the answer's words: there is no column for
-- them, and the operator's alert names the Bot and the ids and leaves the answer on the VM. Cascades
-- with the person, the conversation and the Bot, since a rating of an answer nobody can look at any
-- more is about nothing.

CREATE TYPE "public"."laf_answer_rating" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TABLE "laf_answer_ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"rating" "laf_answer_rating" NOT NULL,
	"reason" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "laf_answer_ratings" ADD CONSTRAINT "laf_answer_ratings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_answer_ratings" ADD CONSTRAINT "laf_answer_ratings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_answer_ratings" ADD CONSTRAINT "laf_answer_ratings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "laf_answer_ratings_person_answer_idx" ON "laf_answer_ratings" USING btree ("user_id","channel_id","message_id");--> statement-breakpoint
CREATE INDEX "laf_answer_ratings_updated_at_idx" ON "laf_answer_ratings" USING btree ("updated_at");