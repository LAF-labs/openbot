-- 진단 정보 같이 보내기: the diagnostic details a person can attach to a 문의·의견 message, 2026-09-14.
--
-- The box sent words and at most a path and a code, and "안 돼요" with nothing beside it is a message
-- the operator answers from inside the VM. The bundle is assembled by the server
-- (`support/diagnostics.ts`) and shown to the person before they send it: the build, the health
-- report, their own turns' failure counts and their own recent events — ids, codes and timings, never
-- a message or anything typed. Null unless they ticked the box. It stays in this row and cascades with
-- the person like the rest of it; the alert webhook carries only how much of it there is.

ALTER TABLE "laf_feedback" ADD COLUMN "diagnostics" jsonb;
