-- Two facts that were stored one grain too coarse, 2026-09-11.
--
-- THE ROSTER PREVIEW MOVES FROM THE CHANNEL TO THE THREAD. `channel_threads` is keyed on person and
-- channel, so two people in one channel hold two conversations — and `channels.last_message` was
-- one preview shared between them: the owner's last sentence on a member of staff's roster, and a
-- leaver's last words left on the survivor's row (audit A5-7). The three columns move to the row
-- that IS the conversation.
--
-- Backfilled from each thread's OWN newest thing said, never copied from the channel: a copy would
-- write the owner's sentence into the staff member's row, and the leaver's into the survivor's —
-- the very rows this migration exists to separate. The words come without the markdown marks a
-- preview strips, until that conversation's next message writes a proper one; the time is the
-- message's own stamp, which is what the read mark is compared against, so a conversation that
-- was read stays read.
--
-- THE OUTBOX MAY ADDRESS NOBODY. A fleet notice about a withdrawal is written inside the
-- transaction that deletes the person, so the `users` row the NOT NULL foreign key would name is
-- gone by the time the notice exists (audit A1-4). `user_id` becomes nullable; the FK stays for
-- every row that has a person, and no door that reaches a person is ever offered a row without one.

ALTER TABLE "channel_threads" ADD COLUMN "last_message" text;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD COLUMN "last_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD COLUMN "last_message_agent_id" text;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_last_message_agent_id_agents_id_fk" FOREIGN KEY ("last_message_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_threads_recent_idx" ON "channel_threads" USING btree ("user_id","last_message_at");--> statement-breakpoint
UPDATE "channel_threads" AS t
SET "last_message" = tail."preview",
    "last_message_at" = tail."said_at",
    "last_message_agent_id" = tail."agent_id"
FROM (
  SELECT DISTINCT ON (m."thread_id")
    m."thread_id",
    left(btrim(regexp_replace(regexp_replace(m."message" ->> 'content', '[*`#>]+', '', 'g'), '\s+', ' ', 'g')), 200) AS "preview",
    CASE
      WHEN (m."message" ->> 'lafAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
        THEN (m."message" ->> 'lafAt')::timestamptz
      ELSE m."at"
    END AS "said_at",
    CASE WHEN m."message" ->> 'role' = 'assistant' THEN a."id" END AS "agent_id"
  FROM "laf_thread_messages" AS m
  LEFT JOIN "agents" AS a ON a."id" = (m."message" ->> 'lafAgentId')
  WHERE (m."message" ->> 'role') IN ('user', 'assistant')
    AND jsonb_typeof(m."message" -> 'content') = 'string'
    AND btrim(m."message" ->> 'content') <> ''
  ORDER BY m."thread_id", m."seq" DESC
) AS tail
WHERE tail."thread_id" = t."thread_id";--> statement-breakpoint
ALTER TABLE "channels" DROP CONSTRAINT "channels_last_message_agent_id_agents_id_fk";--> statement-breakpoint
DROP INDEX "channels_recent_activity_idx";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "last_message";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "last_message_at";--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "last_message_agent_id";--> statement-breakpoint
ALTER TABLE "laf_notifications" ALTER COLUMN "user_id" DROP NOT NULL;
