-- A stored copy of the boundaries screen's "ask before writing a file outside notes/" preset,
-- rewritten to the rule that preset writes now. 2026-10-07.
--
-- THE RULE IT WROTE EXEMPTED A FOLDER BY A MATCH THAT IGNORES LETTER CASE. `matches` does, on
-- purpose, and a deployment's disk does not: under `!matches(file.path, "^notes/")` a write to
-- `Notes/x.md` was not asked about, and made a second folder beside the one the label names
-- (pressed on the real computer, on what v0.5.17 ships). The screen now writes
-- `file.folder != "notes"`, which is exact, and a deployment that pressed the old button holds the
-- old text in its one policy row. Left there it would go on not asking, under a row the screen can
-- no longer put a name to.
--
-- ONE STRING, WHOLE, AND NOTHING THAT ONLY LOOKS LIKE IT. `array_replace` swaps an element equal
-- to the old expression and leaves every other element where it was: a rule somebody wrote by hand
-- around the same match — another folder, an extra clause, one space different — is theirs, and is
-- not read here, let alone rewritten (docs/architecture.md says what is wrong with the shape).
--
-- `ask` AND `deny`, NOT `allow`. In the two lists that hold an action back the new rule holds back
-- more — `Notes/` as well — which is what the label always said. In `allow` the same swap would
-- permit more than the row did, and nobody asked for that.
--
-- ONLY A ROW THAT HOLDS IT IS WRITTEN. Without the WHERE this would rewrite every policy row to
-- itself on every deployment; with it a second run finds nothing, and so does a deployment that
-- never pressed the button. `updated_by` and `updated_at` stay: they say who last changed the
-- boundary, and no person did.
--
-- AN ALLOWANCE THAT STILL STANDS GOES WITH ITS RULE. An allowance is kept under the rule that asked
-- (`computer_standing_approvals.rule`: "the rule is part of the key, so rewriting the boundary asks
-- again"), and that is right when a PERSON rewrites a rule. Here the server did, and left alone the
-- allowance would be listed under "it no longer asks about" while its file was asked about again.
-- Moving it widens nothing: an allowance for a write is for one exact file, and every file the old
-- rule asked about the new one asks about too — a file under `Notes/` has no allowance, because it
-- was never asked about.
--
-- "STILL STANDS" IS THE STORE'S OWN MEANING OF IT (`standing-approvals.ts`, `standing()`): not
-- withdrawn, and not past its own clock where it has one. A withdrawn one is a record of what was
-- given and taken back, under the rule it was given under, and stays as it is. So does one whose
-- clock has run out: an answer "for this conversation" or "for today" that ended is no longer
-- anybody's answer, its `revoked_at` is still null — nothing withdraws it until somebody gives
-- the same answer again — and moved, it would say it had been given under a rule that did not
-- exist the day it ended. (The first version of this statement moved those too, reading
-- `revoked_at` alone; Codex's read of the pull request found it.)
--
-- AND NEVER ONTO A SLOT THAT IS TAKEN. One row may hold a Bot's answer for a rule, a scope, a width,
-- a conversation and a task (`computer_standing_approvals_live_idx`), and that index reads
-- `revoked_at` and NOT the clock: a row whose time has run out still holds its slot. So where the
-- new rule already has a row there — standing or run out — the old one is left as it is, and the
-- inner half of the statement deliberately asks less than the outer half does. A migration that
-- failed on that pair would be a deployment that did not start.
--
-- WHAT THIS DOES NOT REACH, AND WHAT DOES. A policy set in `AGENT_COMPUTER_POLICY` is
-- configuration, not a row; and a migration runs once, while a window that read the policy before
-- the upgrade would write it back whole on its next save, the old text with it (measured before
-- this shipped: one such save, and `Notes/x.md` was written unasked again). Both are met where a
-- policy comes IN: the server refuses this one expression in `ask` or `deny`
-- (`server/src/computer/policy-store.ts`, `parseActionPolicy`), and stores no save made against a
-- boundary that is no longer the one in force (`revisionOf`).
--
-- Hand-written, in the empty file `drizzle-kit generate --custom` makes: there is no schema change
-- for `generate` to see, and the snapshot beside it is 0061's with a new id.

UPDATE "action_policy"
SET
  "ask" = array_replace(
    "ask",
    'intent == "write_file" && !matches(file.path, "^notes/")',
    'intent == "write_file" && file.folder != "notes"'
  ),
  "deny" = array_replace(
    "deny",
    'intent == "write_file" && !matches(file.path, "^notes/")',
    'intent == "write_file" && file.folder != "notes"'
  )
WHERE 'intent == "write_file" && !matches(file.path, "^notes/")' = ANY ("ask")
   OR 'intent == "write_file" && !matches(file.path, "^notes/")' = ANY ("deny");
--> statement-breakpoint
UPDATE "computer_standing_approvals" AS "given"
SET "rule" = 'intent == "write_file" && file.folder != "notes"'
WHERE "given"."rule" = 'intent == "write_file" && !matches(file.path, "^notes/")'
  AND "given"."revoked_at" IS NULL
  AND ("given"."expires_at" IS NULL OR "given"."expires_at" > now())
  AND NOT EXISTS (
    SELECT 1
    FROM "computer_standing_approvals" AS "holding"
    WHERE "holding"."rule" = 'intent == "write_file" && file.folder != "notes"'
      AND "holding"."revoked_at" IS NULL
      AND "holding"."bot_id" = "given"."bot_id"
      AND "holding"."scope" = "given"."scope"
      AND "holding"."tier" = "given"."tier"
      AND coalesce("holding"."thread_id", '') = coalesce("given"."thread_id", '')
      AND coalesce("holding"."task_id", '') = coalesce("given"."task_id", '')
  );
