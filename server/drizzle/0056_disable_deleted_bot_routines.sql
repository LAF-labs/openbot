-- The routines of Bots deleted before deletion removed anything, switched off. 2026-09-26.
--
-- Until today `DELETE /api/agents/:id` set `agent_profiles.deleted_at` and nothing else, so a
-- deleted Bot's routines stayed enabled: the ticker claimed them on every tick, each run failed
-- `laf:turn_failed` because the Bot was no longer on anybody's roster, and each failure told the
-- person who had deleted the Bot so with a `run.failed` notice. Deleting a Bot now removes its
-- routines with it (`server/src/agents/bot-deletion.ts`), and the ticker refuses a deleted Bot's
-- routine whatever this finds (`server/src/routines/ticker.ts`); this is for the rows already there.
--
-- OFF, NOT DELETED. The Bots this reaches were deleted under a dialog that promised their
-- conversations, routines and memories would go, and they did not. Taking those rows now is the
-- owner's decision about data that has sat in deployed databases for weeks, not a side effect of a
-- schema upgrade — so this changes one switch, which nothing reads for a deleted Bot, and removes
-- nothing. A Bot not deleted is never touched: the test is `deleted_at IS NOT NULL` and nothing else.
UPDATE "laf_routines"
SET "enabled" = false, "updated_at" = now()
WHERE "enabled"
  AND "agent_id" IN (
    SELECT "agent_id" FROM "agent_profiles" WHERE "deleted_at" IS NOT NULL
  );
