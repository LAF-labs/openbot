-- ONE CONVERSATION STORE, AND A DATA MODEL THAT STOPS LYING.
--
-- Three things happen here and each one is a decision recorded in docs/laf/redesign-2026-09.md
-- (§5.4 e and §5.5):
--
--   1. `laf_thread_snapshots` — one jsonb array per thread, written by three call sites with two
--      different disciplines — becomes `laf_thread_messages`, one append-only row per message. The
--      rows are COPIED, not recreated: every message this deployment holds moves across below.
--   2. `intelligence_channel_mappings` is renamed to `channel_threads`. The old name is a fossil of
--      a hosted service this fork does not use.
--   3. The `laf_*` and `computer_*` tables get the foreign keys, enums and indexes they never had:
--      a Bot could be deleted and its routines went on being claimed every tick, and its standing
--      allowances went on standing.
--
-- Rows that would violate a new constraint are cleared BEFORE it is added, and each cleanup says
-- out loud how many rows it touched (RAISE NOTICE) rather than doing it silently.

CREATE TYPE "public"."laf_routine_schedule_kind" AS ENUM('interval', 'daily');--> statement-breakpoint
CREATE TYPE "public"."laf_run_origin" AS ENUM('chat', 'routine', 'wake', 'handoff', 'room');--> statement-breakpoint
CREATE TYPE "public"."laf_run_status" AS ENUM('running', 'done', 'error', 'stopped', 'unknown');--> statement-breakpoint
CREATE TABLE "laf_thread_messages" (
	"thread_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"message" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text,
	CONSTRAINT "laf_thread_messages_thread_id_seq_pk" PRIMARY KEY("thread_id","seq")
);
--> statement-breakpoint
-- EVERY MESSAGE, MOVED ACROSS.
--
-- `seq` is the message's position in the array it came out of, so a conversation reads back in the
-- order it was said. `at` is the message's own `lafAt` stamp where it has one and the snapshot's
-- `updated_at` where it does not — which is why the transcript keeps reading `lafAt` out of the
-- jsonb rather than this column: a row backfilled from `updated_at` knows when its snapshot was
-- last saved and nothing more, and a time separator drawn from that would be invented.
--
-- The `jsonb_typeof` branch is the double-encoding self-heal. A thread written before the driver's
-- array handling was understood holds a jsonb STRING containing the array; reading that as "no
-- messages" is how an old conversation quietly becomes an empty one. It is parsed instead, and only
-- when it actually looks like an array — a string that is not one becomes zero rows rather than an
-- error that stops the migration.
--
-- `DISTINCT ON` because the unique index below is about to insist a message id appears once per
-- thread. The old `jsonb || jsonb` appends had nothing enforcing that; the first occurrence wins,
-- which is the same rule `appendMessages` follows now.
INSERT INTO "laf_thread_messages" ("thread_id", "seq", "message", "at")
SELECT DISTINCT ON (parsed."thread_id", entry."value" ->> 'id')
	parsed."thread_id",
	entry."ordinality",
	entry."value",
	COALESCE(
		CASE
			WHEN entry."value" ->> 'lafAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]'
			THEN (entry."value" ->> 'lafAt')::timestamptz
		END,
		parsed."updated_at"
	)
FROM (
	SELECT
		"thread_id",
		"updated_at",
		CASE jsonb_typeof("messages")
			WHEN 'array' THEN "messages"
			WHEN 'string' THEN
				CASE WHEN ("messages" #>> '{}') ~ '^\s*\[' THEN ("messages" #>> '{}')::jsonb ELSE '[]'::jsonb END
			ELSE '[]'::jsonb
		END AS "messages"
	FROM "laf_thread_snapshots"
) AS parsed
CROSS JOIN LATERAL jsonb_array_elements(parsed."messages") WITH ORDINALITY AS entry("value", "ordinality")
WHERE jsonb_typeof(entry."value") = 'object' AND entry."value" ->> 'id' IS NOT NULL
ORDER BY parsed."thread_id", entry."value" ->> 'id', entry."ordinality";--> statement-breakpoint
DO $$
DECLARE threads bigint; messages bigint;
BEGIN
	SELECT count(DISTINCT "thread_id"), count(*) INTO threads, messages FROM "laf_thread_messages";
	RAISE NOTICE '0026: copied % message(s) across % thread(s) out of laf_thread_snapshots', messages, threads;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "laf_thread_messages_message_id_idx" ON "laf_thread_messages" USING btree ("thread_id",("message" ->> 'id'));--> statement-breakpoint
DROP TABLE "laf_thread_snapshots" CASCADE;--> statement-breakpoint
ALTER TABLE "intelligence_channel_mappings" RENAME TO "channel_threads";--> statement-breakpoint
ALTER TABLE "laf_routines" RENAME COLUMN "daily_utc" TO "daily_local";--> statement-breakpoint
ALTER TABLE "channel_threads" DROP CONSTRAINT "intelligence_channel_mappings_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_threads" DROP CONSTRAINT "intelligence_channel_mappings_channel_id_channels_id_fk";
--> statement-breakpoint
DROP INDEX "intelligence_channel_mappings_thread_idx";--> statement-breakpoint
ALTER TABLE "channel_threads" DROP CONSTRAINT "intelligence_channel_mappings_user_id_channel_id_pk";--> statement-breakpoint
-- THE JSONB THAT WAS NEVER JSONB.
--
-- `laf_routine_runs.steps` was written through drizzle's own `jsonb()`, which serialises the value
-- before Bun's driver serialises it again: every row ever written holds a jsonb STRING. The
-- Routines page reads `steps.reduce(…)`, so the first run it drew a shape for would have thrown.
-- The schema uses the array-aware custom type now; these are the rows already on disk.
UPDATE "laf_routine_runs" SET "steps" = ("steps" #>> '{}')::jsonb WHERE jsonb_typeof("steps") = 'string';--> statement-breakpoint
DO $$
DECLARE repaired bigint;
BEGIN
	SELECT count(*) INTO repaired FROM "laf_routine_runs" WHERE jsonb_typeof("steps") = 'array';
	RAISE NOTICE '0026: laf_routine_runs.steps now holds % array-shaped row(s)', repaired;
END $$;--> statement-breakpoint
ALTER TABLE "laf_routines" ALTER COLUMN "schedule_kind" SET DATA TYPE "public"."laf_routine_schedule_kind" USING "schedule_kind"::"public"."laf_routine_schedule_kind";--> statement-breakpoint
ALTER TABLE "laf_routines" ALTER COLUMN "created_by_id" DROP NOT NULL;--> statement-breakpoint
-- The partial index has to stand aside for the type change.
--
-- `laf_thread_runs_live_idx` is `WHERE status = 'running'`, which is a comparison against text.
-- Retyping the column to an enum leaves that predicate with no operator to run — "operator does
-- not exist: laf_run_status = text" — and the ALTER refuses. Dropped and rebuilt around it, with
-- the same definition 0013 gave it.
DROP INDEX "laf_thread_runs_live_idx";--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ALTER COLUMN "status" SET DATA TYPE "public"."laf_run_status" USING "status"::"public"."laf_run_status";--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ALTER COLUMN "origin" SET DEFAULT 'chat'::"public"."laf_run_origin";--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ALTER COLUMN "origin" SET DATA TYPE "public"."laf_run_origin" USING "origin"::"public"."laf_run_origin";--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id");--> statement-breakpoint
-- THE ORPHANS, CLEARED BEFORE THE CONSTRAINTS THAT WOULD REFUSE THEM.
--
-- Every one of these rows exists because these columns were plain text. A run whose Bot is gone
-- keeps its history and loses the name (the roster already ignores a run with no Bot); a routine
-- whose Bot is gone is deleted, because a routine with no Bot is not dormant — it is claimed on
-- every tick and fails, forever; an allowance for a Bot that is gone is a standing "yes" with
-- nothing to say it to.
DO $$
DECLARE touched bigint;
BEGIN
	UPDATE "laf_thread_runs" SET "agent_id" = NULL
	WHERE "agent_id" IS NOT NULL AND "agent_id" NOT IN (SELECT "id" FROM "agents");
	GET DIAGNOSTICS touched = ROW_COUNT;
	RAISE NOTICE '0026: laf_thread_runs — % run(s) named a Bot that no longer exists; agent_id cleared', touched;

	UPDATE "laf_routines" SET "created_by_id" = NULL
	WHERE "created_by_id" IS NOT NULL AND "created_by_id" NOT IN (SELECT "id" FROM "users");
	GET DIAGNOSTICS touched = ROW_COUNT;
	RAISE NOTICE '0026: laf_routines — % routine(s) named an author with no account; created_by_id cleared', touched;

	DELETE FROM "laf_routine_runs"
	WHERE "routine_id" IN (SELECT "id" FROM "laf_routines" WHERE "agent_id" NOT IN (SELECT "id" FROM "agents"));
	GET DIAGNOSTICS touched = ROW_COUNT;
	RAISE NOTICE '0026: laf_routine_runs — % run(s) belonged to a routine whose Bot is gone; deleted', touched;

	DELETE FROM "laf_routines" WHERE "agent_id" NOT IN (SELECT "id" FROM "agents");
	GET DIAGNOSTICS touched = ROW_COUNT;
	RAISE NOTICE '0026: laf_routines — % routine(s) drove a Bot that no longer exists; deleted', touched;

	DELETE FROM "laf_routine_runs" WHERE "routine_id" NOT IN (SELECT "id" FROM "laf_routines");
	GET DIAGNOSTICS touched = ROW_COUNT;
	RAISE NOTICE '0026: laf_routine_runs — % run(s) belonged to no routine at all; deleted', touched;

	DELETE FROM "computer_standing_approvals" WHERE "bot_id" NOT IN (SELECT "id" FROM "agents");
	GET DIAGNOSTICS touched = ROW_COUNT;
	RAISE NOTICE '0026: computer_standing_approvals — % allowance(s) named a Bot that no longer exists; deleted', touched;
END $$;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_standing_approvals" ADD CONSTRAINT "computer_standing_approvals_bot_id_agents_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_routine_runs" ADD CONSTRAINT "laf_routine_runs_routine_id_laf_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."laf_routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_routines" ADD CONSTRAINT "laf_routines_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_routines" ADD CONSTRAINT "laf_routines_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laf_thread_runs" ADD CONSTRAINT "laf_thread_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_type_created_at_idx" ON "audit_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_created_at_idx" ON "audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_threads_thread_idx" ON "channel_threads" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "laf_thread_runs_started_at_idx" ON "laf_thread_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "laf_thread_runs_live_idx" ON "laf_thread_runs" USING btree ("user_id","started_at") WHERE "laf_thread_runs"."status" = 'running';
