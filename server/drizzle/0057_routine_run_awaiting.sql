-- Whether a routine's run stopped for a person's answer, as a fact beside its answer. 2026-09-26.
--
-- A run that met a question nobody could answer at 03:00 appended a line to its answer, and the line
-- was the refusal's `reason` — the sentence written for the model ("…말하고 멈춰라. 다른 길로
-- 돌아가지 마라."). The person read the model's instruction in their conversation, and the next run
-- was fed it back as what it had reported. The fact goes here now (`laf:awaiting_approval`, or null)
-- and the Routines page says it in its own words; rows written before stay null.
ALTER TABLE "laf_routine_runs" ADD COLUMN "awaiting" text;