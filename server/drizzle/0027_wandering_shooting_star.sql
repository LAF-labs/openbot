-- THE SENTENCE AN ALLOWANCE WAS GRANTED AGAINST BECOMES THE FACTS IT WAS GRANTED ABOUT.
--
-- `question` held one English sentence — "The Bot wants to press “출금 승인” on admin.example.com."
-- — assembled by `describeAsk` in `computer/policy.ts` and rendered verbatim on the Boundaries page,
-- in a product whose surface is Korean. That function is gone (docs/laf/redesign-2026-09.md §5.1(b)):
-- the server sends the facts and the surface owns the words. Nothing can compose that sentence any
-- more, so a column holding copies of it would fill with nothing from here on.
--
-- `subject` is nullable and stays nullable. Rows granted before today have no subject and none is
-- invented for them; the page falls back to what an allowance has always been about, which is its
-- scope — this Bot, anything on this site — and that is on the row already. What is NOT lost by
-- dropping the column: who granted it, when, over what, and under which rule, all of which are the
-- allowance itself. The question it came from is still in the audit trail, joined by the approval id
-- on the `approval.standing_granted` row.
--
-- Numbered 0027 at merge: it was written as 0026 beside the conversation-store migration that took
-- that number first, and the snapshot here is that one with the single column swap applied.
ALTER TABLE "computer_standing_approvals" ADD COLUMN "subject" jsonb;--> statement-breakpoint
ALTER TABLE "computer_standing_approvals" DROP COLUMN "question";
