# Routines

A routine is an instruction, a Bot, and a clock: "check the store reviews and
summarize the new ones", every morning, without anybody typing it.

## Shape

The instruction is a sentence, deliberately — something its owner can read
back and edit. The Bot runs it server-side **with its tools**: the loop in
`runner/unattended.ts` offers the model the same computer tools and granted
plugins the browser offers, executes whatever it asks for through the same
gateway and plugin store — policy, grants, audit row and approval registry all
underneath — appends the results and runs again until the model stops asking,
or the step budget (12) or the run timeout (ten minutes) ends it. So a routine
can open a page, read it, save a note, or call a plugin, and answer from
what it found.

The answer is what the Bot said on its **last** turn. A model narrates ("let
me check both pages") before each tool call; delivering every turn's prose
put three of those ahead of the one sentence that was asked for.

A run is only a success if the Bot finished it. A stream that ends in
`RUN_ERROR` — the stall watchdog gave up on it, the provider failed — or that
simply closes without `RUN_FINISHED` is recorded as failed with the reason,
not as a short answer made of whatever prose had arrived before the cut. The
bundled agent sends an SSE comment every fifteen seconds while its model is
quiet, so a reasoning model's minute of thought does not read as a stall.

Each run's record keeps its turns (`steps`): how long each took, which tools
it asked for and whether they went through. The routines page shows them as
"3 turns · 2 tools · 21s" next to the outcome.

Two tools are deliberately withheld: `computer_request_help` and
`computer_request_secret` hand the wheel to a person at the screen, and there is
no screen. A run that hits an ask-rule or needs a sign-in does not wait; it says
so in its answer (marked ⏸) and stops. The approval it raised stays pending for
its usual ten minutes, so a person who reads the answer in time can still grant
it.

The answer lands in the Bot's own conversation as one message headed by the
routine's name, and marks the room unread.

## When it does not finish

A run that ends in `RUN_ERROR`, hits its ten-minute deadline, or is found still
open when the server comes back up is reported in three places, none of which
is the Routines page:

- **The conversation.** The failure path leaves one message headed by the
  routine's name and nothing else, carrying the failed run's id
  (`routines/deliver.ts`, `createRoutineFailureDelivery`). The transcript draws
  the red line under it from `GET /api/channels/:id/failures` — the same reader
  a failed chat turn uses, joining the ledger row to the message by `run_id` —
  and the room goes unread. The sentence is the surface's; the server wrote a
  name and a fact code. A routine's ledger row now carries the conversation's
  `thread_id` for exactly this join.
- **The outbox.** The `routine.ran` audit row says `ok: false`, who to tell
  (`actor`), the failure as a code (`failure`, one of the transcript's
  `laf:turn_*` codes) and the conversation it was marked in (`channelId`); the
  outbox watch on the trail (`notifications/from-audit.ts`) turns that into a
  `run.failed` row carrying `run: { origin, label, code }`. It goes out through
  the socket and the webhook. Never AlimTalk: there is no template for it, and
  a phone buzzing about something nobody can act on is how a channel gets
  muted.
- **The trail.** The same `routine.ran` row, as always.

A run the server restarted under is the same failure with a different code.
Boot reconciles every `running` row to `unknown` (`runner/laf-runner.ts`),
then `reportInterruptedRuns` marks each routine's conversation and writes a
`run.failed` row for each run that had a Bot and a person, with
`laf:turn_interrupted` — a code that claims nothing about why, because nothing
is known. A chat turn cut the same way gets the same line under the person's
own message. An approval card that was open when the server restarted is gone
with the registry it lived in (`deployment-model.md`): the card disappears, the
run it belonged to is reported as above, and the Bot asks again the next time
it reaches the same boundary. That is the allowed behaviour, not a bug to
paper over with a persisted question nobody could bind to a run that no longer
exists.

One unattended run per Bot at a time, through a lane shared with every other
server-side path (`runner/bot-lane.ts`). An account has one virtual computer
and its Bots share it, so a routine firing at seven and a room turn asking the
same Bot a question would otherwise drive one browser at once — each one's
snapshot going stale under the other. The lane is shared rather than private
to routines because two services each serialising against themselves would
not see each other. A coworker being *asked* by another
Bot still runs toolless (`agents/coworker-call.ts`) — that is what makes a
handoff one hop by construction.

## Scheduling

`interval` (every N minutes, minimum five) or `daily` (HH:MM on the wall
clock of an IANA zone, optionally restricted to weekdays 0–6; rows written
before zones existed read as UTC). The whole
scheduler is one column: a tick claims a due routine by advancing `nextRunAt`
in a conditional UPDATE. The claim precedes the run — a crash mid-run costs one
execution rather than repeating one, and a tick that overlaps the previous one
on the single server process cannot fire the same routine twice.

### Catching up

A window that has passed is either **caught up** — run once, now — or
**skipped**, and the line between them is a **grace of half the period,
clamped to 2 minutes–2 hours** (`catchUpGraceMs`; the shape Hermes' scheduler
uses). Within the grace the routine runs once; however many windows fell inside
the gap, the claim has already moved the clock from the moment of the tick, so
the misses are collapsed and never queued. Past the grace the window is let go
and the clock is on the next one.

| schedule | period | grace |
|---|---|---|
| every 5 min | 5 min | 2.5 min |
| every 30 min | 30 min | 15 min |
| every 60 min | 1 h | 30 min |
| every 5 h | 5 h | 2 h (clamped) |
| daily, any weekdays | 1 day | 2 h (clamped) |

So a VM that was off overnight does not deliver yesterday's seven o'clock
briefing at nine, and a five-minute monitor that was down for a quarter of an
hour does not deliver three verdicts — or one stale one — when it comes back;
it simply runs at its next slot. A briefing that was six minutes late because
the server restarted at 07:29 still arrives.

Both outcomes leave a row, and the claim is what makes either safe to write —
exactly one pass takes the routine: `routine.caught_up` when the run was later
than one tick can explain, `routine.skipped_missed` when it was let go. Each
carries `lateByMinutes`, `graceMinutes` and the window that was `missed`; the
skip also carries the `next` one.

## Records

Each routine keeps its last twenty runs (`laf_routine_runs`), which is what an
operator actually reads. The history of record is `audit_events`: every firing
writes a `routine.ran` row whichever way it went (with `failure` and
`channelId` when it went badly), a late window that ran writes
`routine.caught_up`, and one that was let go writes `routine.skipped_missed`.

## Ownership

A routine belongs to the **Bot's owner**, not only to whoever typed it. Staff
leave, and a shop owner locked out of the routines running on their own Bot has
no way in. The cap is counted per person.

## Limits

Twenty routines per person. Enforced at creation, inside the transaction, so two
requests racing for the last slot serialize. The refusal carries a code
(`laf:routine_cap_reached`) and the surface writes the sentence — the server's
own English is a fallback for a code the app does not know.

## Surface

`/routines` in the app: create, enable/disable (re-enabling re-arms from now —
a routine paused for a week must not fire a backlog), run now, delete, and the
recent runs inline. API under `/api/routines`.

## Suggestions

`/routines` offers up to five routines from a curated catalogue
(`server/src/routines/suggestion-catalog.ts`) — 아침 브리핑, 리뷰 감시, 미답
문의 알림, 주간 정산 요약 and so on — the shape of Hermes Agent's routine
suggestions, for a Korean shop. The rules:

- **Consent first.** Nothing is created until 만들기 is pressed. Accepting
  goes through the same `create` a typed routine takes, on the Bot the card
  names, and the routine carries the card's key (`laf_routines.suggestion_key`).
- **Offered only when it can run.** Each entry names the sites and accounts it
  can run on; one of them must be *connected* — as `/api/connections/overview`
  decides it, so a site that needs a login again does not count. A person with
  no Bot is offered nothing. The one entry that needs nothing (세금 일정) goes
  last, so it is what somebody with nothing connected sees alone.
- **One per key.** A routine carrying the key, or one with the same name,
  hides the card; deleting that routine brings it back.
- **다음에 is forever.** A dismissal is a row in
  `laf_routine_suggestion_dismissals`, per person and key, and never re-offered.
- **At most five**, in catalogue order. The next moves up as the person decides.

API under `/api/routines/suggestions`: `GET /`, `POST /:key/accept`
(`{ agentId? }`, 201 with the routine), `POST /:key/dismiss`. The card's own
sentence — why it is worth having — is the app's (`lib/routines/suggestions.ts`);
the name and the instruction are the catalogue's, stored verbatim.

## Triggers

Every routine is born with a webhook: `POST /api/routines/:id/trigger` with the
token in an `x-trigger-token` header — a header, never the URL, because URLs
land in logs. The token is shown once at creation and stored only as a hash.
A request body, if the sender attaches one, rides into the run appended to the
instruction (bounded at 4 KB). The trigger answers `202` as soon as the run is
claimed — a sender gives a receiver seconds, a run with tools takes minutes,
and a sender kept waiting retries into the debounce. Deliveries are debounced
to one run per thirty seconds, which is what an at-least-once sender expects a
receiver to do; a wrong token and a missing routine are the same 404, so a
prober learns nothing.
