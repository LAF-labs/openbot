# Routines

A routine is an instruction, a Bot, and a clock: "check the store reviews and
summarize the new ones", every morning, without anybody typing it.

## Shape

The instruction is a sentence, deliberately — something its owner can read
back and edit. The Bot runs it server-side through the same toolless path a
coworker being asked uses (`agents/coworker-call.ts`), so a routine can think
and write but cannot yet click; the browser-driving version arrives when tool
execution moves off the browser.

## Scheduling

`interval` (every N minutes, minimum five) or `daily` (HH:MM, UTC). The whole
scheduler is one column: a tick claims a due routine by advancing `nextRunAt`
in a conditional UPDATE, so two server processes ticking the same table cannot
both fire it. The claim precedes the run — a crash mid-run costs one execution
rather than repeating one.

## Records

Each routine keeps its last twenty runs (`laf_routine_runs`), which is what an
operator actually reads. The history of record is `audit_events`: every firing
writes a `routine.ran` row, whichever way it went.

## Limits

Twenty routines per account. Enforced at creation, inside the transaction, so
two requests racing for the last slot serialize.

## Surface

`/routines` in the app: create, enable/disable (re-enabling re-arms from now —
a routine paused for a week must not fire a backlog), run now, delete, and the
recent runs inline. API under `/api/routines`.

## Triggers

Every routine is born with a webhook: `POST /api/routines/:id/trigger` with the
token in an `x-trigger-token` header — a header, never the URL, because URLs
land in logs. The token is shown once at creation and stored only as a hash.
A request body, if the sender attaches one, rides into the run appended to the
instruction (bounded at 4 KB). Deliveries are debounced to one run per thirty
seconds, which is what an at-least-once sender expects a receiver to do; a
wrong token and a missing routine are the same 404, so a prober learns
nothing.
