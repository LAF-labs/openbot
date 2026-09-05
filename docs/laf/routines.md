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

A window more than an hour late is **skipped**, not fired
(`MISSED_WINDOW_MS`). A VM that was off overnight would otherwise deliver
yesterday's seven o'clock briefing at nine, and an hourly monitor that missed six
windows would deliver six of them at once. The claim is what makes the skip safe
to record: exactly one pass takes the row, so exactly one `routine.skipped` row
is written — with how many minutes late it was — and the clock is already on the
next window either way.

## Records

Each routine keeps its last twenty runs (`laf_routine_runs`), which is what an
operator actually reads. The history of record is `audit_events`: every firing
writes a `routine.ran` row whichever way it went, and a window that was let go
writes `routine.skipped`.

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
