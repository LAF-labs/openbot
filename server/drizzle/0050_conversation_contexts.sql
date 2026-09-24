-- What a Bot's conversation was told, frozen, 2026-09-25 (agent harness phase 1).
--
-- The provider reads a prompt from its cache only as far as it is byte-identical to the last one.
-- An epoch freezes the Bot's context layer (name, job, shop, place, zone, date, memories, skills)
-- once per conversation, and a change mid-epoch is appended to the person's next message as a
-- reminder. Both are kept here so a restart sends the same bytes: the messages cannot carry them,
-- because every run hands the history back from the browser and a copy that differs overwrites the
-- row. See server/src/context/conversations.ts.

CREATE TABLE "laf_conversation_contexts" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"epoch" jsonb NOT NULL,
	"known" jsonb NOT NULL,
	"reminders" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_user_message_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "laf_conversation_contexts" ADD CONSTRAINT "laf_conversation_contexts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;