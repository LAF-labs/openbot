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
-- WHAT THIS DOES NOT REACH. A policy set in `AGENT_COMPUTER_POLICY` is configuration, not a row.
-- And a standing allowance granted under the old text is kept under that text
-- (`computer_standing_approvals.rule`) and answers for nothing now — the rule is part of an
-- allowance's key so that rewriting a boundary asks again, and this rule's meaning did change. It
-- is still listed, and can still be withdrawn.
--
-- AND IT RUNS ONCE. A window that read the policy before the upgrade writes it back whole on its
-- next save, the old text with it, and nothing where a policy is saved refuses or rewrites that
-- (measured before this shipped: one such save and `Notes/x.md` is written unasked again).
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
