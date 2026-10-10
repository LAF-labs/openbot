-- What a conversation is: the Bot's one main conversation, or a project beside it. 2026-10-10.
-- (docs/laf/redesign-2026-10.md §3, piece 4-1.)
--
-- UNTIL NOW "THE CONVERSATION" WAS A RULE: the oldest channel a person has that holds only that
-- Bot (`server/src/channels/solo-channel.ts`). Projects are conversations with the same Bot beside
-- that one, and a rule cannot tell a second conversation from the first, so the first is written
-- down. Every channel starts `main`, which is what a channel made from now on is.
--
-- THE BACKFILL SAYS WHAT THE RULE SAID, IN THE RULE'S OWN ORDER. For a person and a Bot, the
-- channel the rule would have answered — oldest by `created_at`, then by `id` — stays `main`. An
-- order that differed by one tie would hand an account from before 2026-09-24 a different
-- conversation as its main on the day it upgrades: its routines would deliver somewhere else and
-- 만든 것 would read another thread.
--
-- EVERYTHING ELSE IS A PROJECT. The other channels of the same person and Bot — an account from
-- before the cap has several (three Bots with thirteen channels between them, measured then) — are
-- that Bot's projects, their records as they are. So is a channel that holds no Bot or more than
-- one: it was never anybody's main conversation, and left at the default it would read as one.
--
-- 4-1 MARKS; IT MOVES NO FILE. The record has a migrated project's attachment copies go to the
-- project's own folder. There is no such folder before projects can be made (4-2), and SQL cannot
-- move a file: that step is 4-2's.
ALTER TABLE "channels" ADD COLUMN "kind" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
UPDATE "channels" SET "kind" = 'project'
WHERE "id" NOT IN (
  SELECT ranked."channel_id" FROM (
    SELECT
      c."id" AS "channel_id",
      row_number() OVER (
        PARTITION BY m."user_id", a."agent_id"
        ORDER BY c."created_at" ASC, c."id" ASC
      ) AS "position"
    FROM "channels" c
    JOIN "channel_memberships" m ON m."channel_id" = c."id"
    JOIN "channel_threads" t ON t."channel_id" = c."id" AND t."user_id" = m."user_id"
    JOIN "channel_agents" a ON a."channel_id" = c."id"
    WHERE (SELECT count(*) FROM "channel_agents" o WHERE o."channel_id" = c."id") = 1
  ) ranked
  WHERE ranked."position" = 1
);
