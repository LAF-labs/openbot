-- The rows the launch plan's "only customers can teach us" questions are counted from, 2026-09-14.
--
-- laf-control's `laf insights` (core/insights.ts, README §3.13) reads each VM's database for counts
-- and closed codes, and listed what the product did not record. Two of those are audit rows
-- (`onboarding.first_task_pressed`, `support.help_opened`) and need no table. This is the third:
-- WHICH PRESET A BOT WAS SHAPED FROM. The intro card PATCHed a preset's translated title and role
-- and the preset itself was gone, so "which of the eight kinds of work do people pick" had nothing
-- to be counted from.
--
-- A catalogue key or null, and null for every Bot that exists today: nobody recorded a pick for
-- them, and inferring one from a title in whichever language `t()` spoke that day would be a guess
-- written down as a fact. No default, no backfill, no index — it is read by one grouped count.

ALTER TABLE "agent_profiles" ADD COLUMN "preset_id" text;

