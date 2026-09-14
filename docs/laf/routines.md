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

**The same failure again is not news again (2026-09-14).** A failure's
signature is the routine, its code, and the tool the code names. The first
failure of a signature does all of the above; every later one while that
signature's group is open is counted into the group's `run.failed` row
(`count`, `lastAt`) inside the run's own settlement, and writes no heading, no
red line, no unread dot and no notification. The line in the conversation says
"같은 이유로 7번 실패 · 마지막 오전 9:00"; pressing 확인 on it quiets it through
every repeat to come. A success closes the routine's open groups, so the next
failure opens a new one and is told once. The group is a row, so a restart does
not reset it. See `notifications/failure-groups.ts`.

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
`channelId` when it went badly, `failureGroup` when that failure was counted
into a group, and `notepad` when the run changed its notepad),
a late window that ran writes `routine.caught_up`, one that was let go writes
`routine.skipped_missed`, and a person emptying a notepad writes
`routine.notepad_cleared`.

## The notepad — where a routine left off

The jobs a shop hands a routine first — reply drafts for new reviews, answers
for new inquiries, settlement mismatches — are all "since last time". The
previous answer's prose rides into the next run (1,500 characters,
`routines/run.ts`), and that is not a cursor: the Bot has to read "how far did
I get" back out of its own sentences, and a paraphrase or a cut answers a review
twice or skips one. Each routine therefore keeps a **notepad**
(`laf_routine_notepads`, one row per routine; the shape Hermes Agent's per-job
notepad has).

**What it holds.** Up to **20 entries**. An entry is a `note` — a key and one
fact, at most **500 characters** — or a `watermark`: a key and the newest thing
the run handled, as `lastId` (a review number, an order number, a settlement
date) and/or `lastAt` (ISO 8601 *with* a zone; a time without one is refused,
because the server clock would read it nine hours wrong). Keys are letters,
digits, `_`, `-` and `.`, up to 40. The whole notepad is at most **4,096
bytes**, counted as UTF-8 over the entry lines exactly as the next run reads
them, so the ceiling bounds the prompt rather than the raw values.

**How a run reads it.** Inside the Bot's lane — not when the routine was claimed,
so a run queued behind another reads what that one settled. It travels as
`forwardedProps.notepad`; the prompt middleware (`copilot.ts`) parses it down to
its shape and bounds whoever forwarded it (`notepadOf`), and the composer draws
it **in routine mode only**, after the mode text and before the clock, under a
heading that says it is a record and not an instruction
(`shared/prompt/notepad.ko.ts`). Values are JSON-quoted, so a value cannot close
its line and open a "시스템:" line under it. An empty notepad draws nothing.

**How a run writes it: `routine_note`, and why that rung.** One tool —
`watermark`, `set`, `delete` — offered **only to a routine's own run**
(`routines/notepad.ts`, `withNotepad`), the way `skill_view` exists only for a
Bot that holds a skill. The rung below it on the footprint ladder, a structured
field the run's final answer carries, costs no schema and was skipped: a write
that fails validation has to be refused **to the run that made it**, and the
final answer is the one thing a run does after which it can be told nothing — a
cursor refused there stays put while the run that thought it moved it is already
over. It would also re-create the `[SILENT]` marker's paraphrase problem for keys
and values, and the block would have to be stripped from the delivered answer,
the receipt and the carried report. The toolless fallback (`runAgentOnce`,
composed as a coworker) is offered no tool and shown no notepad.

**What a write is held to.** The memory store's scans (`agents/memory-store.ts`):
a note's value and a watermark's id are refused if they read as an instruction,
a key if it has a prompt's structure, and a note's value if it looks like a
secret. A watermark's id is *not* held to the secret scan — the newest order a
shop handled is sixteen digits, which is the shape that scan refuses as a card,
and a cursor that cannot hold an order number is not a cursor. Every refusal is
a fact code the model reads in Korean in the same run
(`shared/prompt/tool-results.ko.ts`): `laf:notepad_arguments_invalid` (with
`field`), `laf:notepad_value_too_long`, `laf:notepad_full` (with the counts),
`laf:notepad_looks_like_instruction`, `laf:notepad_looks_like_a_secret`,
`laf:notepad_no_such_key`; a write that passes is `laf:notepad_staged` or
`laf:notepad_deleted`.

**When it lands.** Nothing is written while the run is out. Each call is applied
to a draft in memory; the settlement writes the draft **first, in the same
transaction** as the delivery, the ledger's ending and the receipt
(`settlement.ts`), over the version the run read (`… ON CONFLICT DO UPDATE …
WHERE version =`), and only for a run whose record says it succeeded. So:

- a run killed before its record commits leaves the cursor where the last
  recorded run left it (`routine-notepad-kill.integration.test.ts`, a real
  SIGKILL between the answer and the commit);
- a run that fails, or whose record rolls back, moves nothing — the next run
  covers the same window again, which for a draft nobody received is the side to
  fail on;
- a person who clears the notepad while a run is out bumps the version, and that
  run's writes — made against the notepad they cleared — are dropped rather than
  written back over the reset.

The `routine.ran` row says which, as a word and never the contents: `notepad:
"written"`, `"superseded"` or `"discarded"`, absent when the run changed nothing.

**The notepad and the failure group are one decision.** Both say where the next
run starts from, and the same settlement writes both: a success lands the draft
and closes the routine's open failure groups; a failure discards the draft and
is counted into its group or opens one. Neither commits without the other, so a
restart never finds the cursor moved past a run the routine is still counting
as failing. The draft is written first, then the groups, then the conversation
— the order is the lock order (notepad row, the routine's group lock, the
thread), the same on both paths (`settlement.ts`, `writeRecord`;
`failure-groups.integration.test.ts` runs the two together).

**Who reads and clears it.** The routine's person, by the same scope as its runs.
The routine's row on `/routines` shows the entries, read-only — a note typed on
that screen would be a "fact" planted in front of a run nobody watches — with a
Clear button that asks first and says what it costs. `GET
/api/routines/:id/notepad` answers `{ notepad: { entries, updatedAt } }`;
`DELETE` empties it and answers `{ cleared }`. A clear that removed something
writes `routine.notepad_cleared` (who, which routine, how many entries); one that
removed nothing writes no row. There is no HTTP door that writes a notepad, the
browser never registers `routine_note` (a chat turn that calls it is answered
`laf:tool_unknown` inside `agent-bot`), and a room's toolkit does not carry it.

**What it costs, measured.** 2026-09-14, the real `agent-bot` with a recording
fake provider (`routine-notepad.test.ts` keeps the bound):

| notepad | entry lines | system message | provider request |
|---|---|---|---|
| empty | 0 B | — | — |
| 20 short entries (key-full) | 1,911 B | +2,192 B | +2,258 B |
| 8 entries at the byte ceiling | 4,094 B | +4,375 B | +4,403 B |

4,375 is the 278-byte heading, its line break, the 4,094 bytes of entries and the
blank line the composer puts between paragraphs — nothing else moved. The tool's
own definition adds **996 bytes** to every request of a routine run and to no
other run (1,262 before its description was cut to the four things it has to
say).

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
a routine paused for a week must not fire a backlog), run now, delete, and — in
the expanded row — the notepad (read, clear) above the recent runs. API under
`/api/routines`.

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
