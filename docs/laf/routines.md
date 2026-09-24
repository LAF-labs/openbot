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
and its Bot is one, so a routine firing at seven and a conversation turn asking
the same Bot a question would otherwise drive one browser at once — each one's
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
`routine.skipped_missed`, a person emptying a notepad writes
`routine.notepad_cleared`, and the unread rule pausing a Bot's routines writes
`routine.paused_unread` (below).

## Editing

`PATCH /api/routines/:id` changes a routine in place: any of `name`,
`instruction` and `schedule`, with the validation and the refusal codes a new
routine gets — a blank name or instruction, every schedule code, and the
deployment's zone for a daily time that names none (a Bot hears "8시" on that
clock). A body with none of the three is `400 laf:routine_nothing_to_change`.
Ownership is the other verbs' (`404 laf:routine_not_found`).

In place because the alternative was deleting it: a routine's id is what its
run history, its notepad and its webhook token hang from, and "move my briefing
to eight" used to be a delete and a create that lost all three. `created_by_id`
is not touched — it is who the routine runs as.

**The clock moves only when the schedule does.** A new schedule re-arms
`next_run_at` from the moment of the edit; a new name or instruction leaves it
alone, and a schedule sent back exactly as it is stored is no change — the form
sends only what changed, and the server ignores an identical schedule too, so an
hourly routine renamed at 05:40 still fires at 06:00.

**The route reads three fields and drops the rest.** `enabled`, `keepRunning`,
`agentId` or `autoReview` in the body change nothing: each is somebody's decision
behind a door of its own, and a Bot's `manage_routine` posts here.

On `/routines`, 수정 in a routine's ⋯ menu opens the create form in the same
panel (`?edit=<id>`), filled in from the row, with the hour and minute read in
the routine's own zone. The Bot is shown and not offered: a routine stays with
the Bot whose history and conversation it belongs to.

**The Bot's tool.** `manage_routine` has `create`, `list`, `update` and
`delete`. `update` sends only the fields given — name, instruction, schedule
through `PATCH`, and `enabled` through the switch's route — and says the stored
name and schedule back. Which routine is `routineId`: its id, or its exact
current name when one routine has it. `list` shows the Bot its own routines with
ids, schedules and on/off, and a name that matches nothing or two routines is
refused with that list rather than guessed at — no result a Bot was handed
carried an id before, so an update "by id" was a guess. Every lookup is among the
calling Bot's routines only: the API scopes by person, and a Bot must not reach a
sibling Bot's routine. Nothing in the tool reaches keep-running.

## Paused for going unread

A routine that runs every day while nobody opens the conversation it delivers
into spends the day's allowance and the shared model key on answers nobody
reads, and nothing tells the person. The rule (`routines/unread.ts`), per Bot and
per person: count the results that Bot's routines delivered into that person's
conversation since they last opened it (`channel_memberships.last_read_at`; for
one never opened, since they joined it). When there are **at least three** and
the oldest has waited **a week**, the routines that delivered them are paused —
`enabled = false`, `paused_reason = 'unread'`, `paused_at`. Both numbers, because
either alone is wrong: three alone pauses a daily briefing after a long weekend,
a week alone pauses a weekly report after the first one nobody opened.

- **A delivery** is a `routine.ran` trail row that says `delivered: true`,
  written for a run whose answer went into the conversation; `[SILENT]` and
  failed runs delivered nothing to read, and neither did a run stopped with
  모두 멈추기 — it is settled not ok, delivers nothing and its row says
  `stopped` (`routine-unread.integration.test.ts` runs a real stop through the
  trail to hold that). The trail rather than the receipts,
  because receipts are pruned to twenty a routine: a routine that reports every
  half hour keeps ten hours of them, and its oldest unread result would never
  look a week old. A deployment keeping less than a week of trail
  (`AUDIT_RETENTION_DAYS`) never pauses, and runs from before the trail said
  `delivered` are not counted.
- **Only routines the rule governs count** — on, and not `keep_running` — and
  only those in the pile are paused, so a monitor on the same Bot that answers
  `[SILENT]` until something happens keeps watching. A routine marked 계속
  돌리기 is never paused, and its unread results are not evidence against its
  siblings.
- **Each routine counts from its last resume** (`resumed_at`) as well as from the
  read mark. Turning a paused routine back on is not reading its conversation,
  and without this the same pile would pause it again on the next tick.
- **A Bot the person has no conversation with** delivered nowhere and is left
  alone.

**Where it runs.** On the clock, for the Bots with a routine due in that pass,
before anything is claimed (`ticker.ts`): the run it saves is the one about to
happen, and the claim asks for `enabled`, so a paused routine is simply not
taken. The pause is a conditional UPDATE on `enabled AND NOT keep_running`, so a
second sweep, or a person's switch in between, pauses nothing twice. Run now and
the webhook are not swept: both are somebody asking for a run.

**Telling the person, once per pause.** The sweep writes one
`routine.paused_unread` trail row (Bot, person, conversation, routine ids, how
many results were waiting and since when — never what they said), and the
outbox watch turns it into one `routine.paused` notification carrying
`pause: { reason, routineIds, count, unread, since }` and the conversation's
`channelId` (`notifications/from-audit.ts`). Socket and webhook, never 알림톡.
The page words it ("결과를 한동안 보지 않으셔서 루틴 {n}개를 멈췄어요"), lands the
click on the conversation, and refetches the routine list so an open routines
page shows the pause at once.

**Answering it.** Only the person: `POST /api/routines/resume`
`{ agentId, keepRunning }` turns back on every routine of that Bot the rule
paused — and none they switched off themselves — re-armed from now, and with
`keepRunning: true` exempts them for good (the banner's 다시 켜기 and 계속
돌리기). `POST /api/routines/:id/keep-running` `{ keepRunning }` is the ⋯ menu's
안 읽어도 계속 돌리기 for one routine. Any press of the enabled switch clears the
reason — on is "run it", off is "I turned it off" — and switching back on from
off records `resumed_at`.

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
(`routines/notepad.ts`, `withNotepad`) — a routine run is a conversation of
its own, so the tool is there from its first request to its last. The rung below it on the footprint ladder, a structured
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
`laf:tool_unknown` inside `agent-bot`).

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

A routine belongs to the **Bot's owner**, not only to whoever typed it. On a
deployment that belongs to one account those are the same person; the rule is
for rows left over from before that — a routine on the owner's Bot whose author
is an account the sign-in list no longer admits is still the owner's to see,
pause and delete. The cap is counted per account.

## Who it runs as

A routine runs as its author, on the deployment's one browser. An author the
sign-in list no longer admits acts on nothing (docs/laf/deployment-model.md,
2026-09-16), so their routine is run by no door, and each door says so with a
`routine.skipped_not_admitted` audit row carrying `via`:

- **the clock** claims the window as usual and skips it — one row per window,
  like a missed one;
- **Run now** is refused with `409 laf:routine_author_not_admitted`, and the
  routine's clock does not move — the page says why in Korean;
- **the webhook** claims the window and answers
  `{"ran":false,"reason":"not_admitted"}`, so a sender retrying in a burst writes
  one row, not one per retry.

A skipped routine is not a failed run: nothing is recorded in its history and
nobody is notified. It is left as it is, and runs again if its author is
admitted again.

## Limits

Twenty routines per person. Enforced at creation, inside the transaction, so two
requests racing for the last slot serialize. The refusal carries a code
(`laf:routine_cap_reached`) and the surface writes the sentence — the server's
own English is a fallback for a code the app does not know.

## Surface

`/routines` in the app: create, edit (수정, in the ⋯ menu), enable/disable
(re-enabling re-arms from now — a routine paused for a week must not fire a
backlog), run now, delete, keep running even if unread (⋯ menu), and — in the
expanded row — the notepad (read, clear) above the recent runs. Routines the
unread rule paused carry a line saying so, under a banner per Bot with 다시 켜기
and 계속 돌리기. API under `/api/routines`.

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
