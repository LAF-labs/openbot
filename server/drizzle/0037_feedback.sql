-- The 문의·의견 box: what a person wrote to the people who run the product, 2026-09-06.
--
-- Its own table rather than an outbox row, because the outbox is a queue the retention tick empties
-- after thirty days and a person's message to the operator is neither a thing to be delivered and
-- forgotten nor a fact about a Bot. `route` and `failure_code` are the two facts "send what is on
-- screen too" means — the path they were on and the last failed turn it drew — and they are null
-- unless the person ticked that box. Never a screenshot, never a transcript; the shape of the row
-- is the rule. Cascades with the person: the words are theirs, and the operator who needed them has
-- had them on the alert webhook already.

CREATE TABLE "laf_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"route" text,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "laf_feedback" ADD CONSTRAINT "laf_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "laf_feedback_created_at_idx" ON "laf_feedback" USING btree ("created_at");
