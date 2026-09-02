-- THE STATE THE DECISION RECORD SAID WAS NEVER MEANT TO BE HERE.
--
-- These three tables were the database twins of the approval registry and the repeat counter, and
-- the server wired them rather than the Maps beside them. Their reason, written in their own
-- comments, was "several servers behind a load balancer each see half of it" — a deployment this
-- product does not have and has recorded that it does not have: one API server process per VM
-- (docs/laf/deployment-model.md, decision §7-1 of docs/laf/redesign-2026-09.md, 2026-09-02). The
-- code and the decision record argued, and the decision record wins.
--
-- What they cost while nobody was reading them: every governed click ran two DELETEs, an INSERT and
-- a COUNT against `computer_repeat_calls`/`computer_repeat_reports` plus up to three more INSERTs at
-- a threshold, and every second a room waited for an answer ran a DELETE and a SELECT against
-- `computer_approvals` — to hold state that a Map in the same process holds for nothing, and that a
-- restart is supposed to forget anyway. A pending question is about a live browser session and a
-- live model run; a restart takes both, so an approval that came back from storage would be a grant
-- for an action nobody could still perform.
--
-- What is NOT dropped: `computer_standing_approvals`. An allowance whose whole point is "stop asking
-- me about this" must outlive the process, so it stays exactly where it is.
--
-- `IF EXISTS` on all three, because a deployment created after this migration never had them, and
-- because the whole reason to write it this way is that dropping something twice must be boring.
DROP TABLE IF EXISTS "computer_approvals" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "computer_repeat_calls" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "computer_repeat_reports" CASCADE;
