# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                               |
| -------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | AG-UI endpoint and optional key reference.                            |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed, owner, visibility, and soft deletion. |
| Personal roster      | `agent_preferences`             | Per-user hidden state.                                                |
| Channel              | `channels`                      | Conversation membership and coworker binding.                         |
| Thread mapping       | `intelligence_channel_mappings` | Channel-to-thread mapping (name predates the fork; threads are local). |

Package-provided agents are public and ownerless. User-created coworkers are owned by the creator.

## Standing role

Remote coworkers receive a system message derived from their title and role description:

```text
You are Expense Manager, Finance Operations.

Review receipts, categorize expenses, and prepare reimbursement reports.

This standing role applies in every channel. Treat channel messages as task-specific instructions within it.
```

The message is ordinary AG-UI system content, so it works with any AG-UI-compatible backend. Editing the role affects the next run.

## Visibility

| Visibility | Who can see and run it      |
| ---------- | --------------------------- |
| `private`  | Owner and administrators.   |
| `public`   | Everyone in the deployment. |

Filtering happens in server/database queries. Package-provided agents cannot be edited or deleted through the product.

## Channels

Starting a channel creates a new conversation and thread, stored in PostgreSQL. Two channels with the same coworker stay separate.

Each channel routes through a channel-local proxy agent id, pinned to that channel's thread id, then forwards to the coworker runtime id.

## Deleting and hiding

Deleting is soft. The coworker stops running, but existing channels remain readable for their members and restore as tombstones.

Hiding is personal roster state. It removes the coworker from one user's list without disabling the coworker for anyone else.

## Default endpoint

Product-created coworkers use:

```dotenv
MANAGED_AGENT_AG_UI_URL=http://localhost:4200/ag-ui
```

The server requires this setting at startup. Package-provided agents use their own `agents.yaml` configuration.

## Register an external AG-UI agent

In `agents.yaml`:

```yaml
agents:
  - id: risk
    name: Risk
    title: Risk & Compliance
    role_description: Investigate policies and controls.
    type: remote-ag-ui
    endpoint: http://risk.internal/ag-ui
```

In the product, create or edit a coworker from `/agents` and set:

- name;
- title;
- role description;
- visibility;
- optional endpoint;
- optional authorization header.

Endpoint registration uses target checks. Cloud metadata addresses are refused under every configuration. Optional keys are write-only: sending a key stores/replaces it, omitting it keeps the existing key, and APIs do not return it.

`POST /api/agents/test-connection` checks whether an endpoint answers before saving it.

## Capabilities

A coworker's role does not grant capabilities. Capabilities are governed separately:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- MCP tools are granted per Bot by administrators;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed by administrators.

See [architecture.md](architecture.md).

## The account's computer, and coworkers asking each other

An account gets **one virtual computer**, and up to **five** coworkers share it
(`server/src/computer/assignment.ts`). The sixth coworker fails to be created
with a clear reason, rather than existing and failing to reach a computer.
What stays per-coworker is governance: policy identity, approvals, repetition
counts, credentials and the audit trail are all keyed on the Bot, so sharing
the desk shares the browser and its logins — deliberately — without sharing
anybody's permissions.

Coworkers can brief each other. `ask_coworker` is a frontend tool available in
every run; the asked coworker answers **server-side, with no tools in the
room**, which is what makes the interaction one hop by construction — a
coworker answering a question has no `ask_coworker` of its own to call. Every
exchange writes a `coworker.asked` audit row, whichever way it went. The
endpoint is `POST /api/agents/:agentId/ask` with `{ from, message }`.

## Being told, when you are not looking

Every Bot carries one preference per person: `notify`, on by default, editable
from the switch on its profile. What it governs is the browser's own
notification, raised when that Bot speaks in a room you are not reading.

The rule is the one this fork already wrote down for the approval buzz and the
morning digest (`server/src/watch/digest.ts`): what is blocked on you leads,
what merely happened follows, everything else stays out of the way. So a reply
in the room you are reading raises nothing — you can see it — and a reply in a
room you left, or in any room at all while the tab sits behind another window,
raises one. Repeats replace: three answers while you were at lunch leave one
notification per room, and the roster behind it carries the count.

The rules are Grok Bot 0.24's, read out of its main process and copied rather than
re-derived — one decider both kinds go through, so the mute, the hidden check
and the throttle are written once and cannot drift apart. A Bot hidden from the
roster says nothing even unmuted (hiding is the stronger statement). A Bot stays
quiet for five seconds per kind after it has spoken, because ONE turn here is
several runs on the wire whenever the Bot touches its computer — without the
throttle a single errand left a row of notifications. A finished Bot is silent;
a blocked one is not.

A Bot that has STOPPED and is waiting on you leads, and it is the one thing
here with a deadline: an unanswered question expires after ten minutes and the
Bot gives up. That notice asks the browser to keep it on screen rather than
fading, and it is raised only while the tab is hidden — a question is raised by
a tool call in the tab you are driving, so a visible tab already draws the card
on the tool call's own line and says so in the status slot wherever you have
scrolled. It does not ride the socket and should not: the browser already holds
the Bot, the id and the sentence.

The rest rides the socket the roster already keeps open
(`app/src/lib/channels/use-channel-events.ts`) rather than a second connection,
and it is the platform `Notification` — no service worker, no push service, no
dependency. **Nothing arrives while the tab is closed**, and the profile says so
rather than implying otherwise. The durable notification is the roster: a room a
Bot has spoken in since you last read it is bold whenever you come back.

Permission is asked for by its own control — on a Bot's profile and in
Settings — and never on load, because a page that asks on load is asking before
anybody can judge the request. It is deliberately NOT tied to the switch: every
Bot starts with `notify` on, so asking only when somebody turns it on would have
meant asking nobody, ever. Refusing leaves the preference alone, because wanting
to hear from a Bot and letting the browser pop a window are two different
answers, and a browser that refuses cannot be asked again by any API — the copy
says so and stops.

## A room with more than one Bot in it

A channel can hold several Bots. Its turn runs ON THE SERVER, and the
browser only watches — the shape Grok Bot 0.24 uses, ported from its host
rather than invented. A tab that closes mid-turn no longer kills the turn,
and two tabs cannot each drive their own version of it.

The room is not any Bot's history. A member answers from a prompt built
fresh for its turn: a header naming the room and who else is in it, the last
stretch of what was said (at most 24 lines, and at most 24,000 characters
across all of them — the per-line cut is not a bound on the prompt, and one
room where a few people pasted a few long things would otherwise stop
answering for everybody), and whose turn it is. It is the whole window
rather than "since you last spoke", because a member turn is a fresh loop
and cannot otherwise see what it itself said two lines ago; its own lines
are marked.
Tool calls, tool results and a Bot's scratch prose are its private working
and never reach the room — the ONLY way a Bot can put words in a room is
the `send_message` tool, so a turn with no call is a Bot with nothing to
add, and a Bot can open a page mid-turn without narrating it at everybody.
A member does carry the tail of its own private conversation with the
person — the last twelve things said, each cut to 1,500 characters, words
only — placed between the conduct note and the turn, where the reference's
unified history sits. The bound is the point: a room turn's worst case is a
known number, not the length of somebody's conversation. Older than that
tail, the Bot is told to ask rather than assume.

Whose turn it is: nobody named means EVERYBODY answers (the reference's
rule, and the opposite of the one we had). Up to three rounds, rotating who
opens each round, ten messages per turn across the room, three per member,
six members — every cap exists to end a conversation between models, which
does not stop on its own. A round in which nobody spoke ends the turn. With
two slots left, or on the last round, members are asked to wrap up.

Two fences for two races. `channels.room_turn_epoch` counts up on every
message the person posts, and every checkpoint compares it against the one
the turn started with — a superseded turn stops at its next member wherever
it is, on whatever process it is on. A per-Bot lane, shared with routines,
keeps two loops off one Bot's browser. Stop bumps the epoch; a member
already thinking still says what it produced.

What the browser sees: `room.*` frames on the roster's socket — the turn
starting, a member opening a message, the WHOLE text so far on each delta
(never an increment, so a dropped frame heals on the next), the message
settling or being refused, the turn ending. The end frame carries how many
members could not take their turn AT ALL, because a Bot whose provider died
otherwise produces the same screen as a colleague with nothing to add. A
member that throws before the model is reached is counted the same way and
the turn goes on without it. A settled message names the
provisional bubble it replaces and carries the stored id and final text, so
the bubble is swapped in place; the first version removed it and waited for
a refetch, and every reply blinked off the screen for a second. The turn's
end frame is sent from a `finally`, so a turn that fails before its first
member cannot leave the room stuck with Stop showing — and because frames
are not replayed, a socket that reconnects mid-turn makes the room let the
turn go and re-read everything: a `room.done` lost with the connection would
otherwise leave the composer disabled with no way out. A turn that really is
still running says so with its next frame. Deltas are instance-local by
design; the settled message goes through `pg_notify` like any other. The
room's transcript is read from `/api/channels/:id/messages`, which serves
the snapshot directly — the runtime's own thread endpoint is answered by our
runner only in local mode, and every message in a room is written by the
server.

Who said what is recorded per message (`lafAgentId` beside `lafAt`) and
drawn as a name above each reply.

A member's action that meets an ask rule is raised to the room. In a
one-to-one conversation the question is drawn on the tool call's own line;
a room draws no tool calls, so a `room.approval` frame carries who asked and
what, and the room shows it above the composer with the same Allow and Deny
the line-level card has. The question is not typing: it is not subject to
the turn-epoch rule, it outlives the turn's end, and it comes down when
answered (the frame arrives a second time with `answered`, for tabs other
than the one that pressed the button). Before this it sat in the server's
registry for its ten minutes where nobody could see it.

And the turn HOLDS for the answer, because in a room the person is there —
up to two minutes, against a member deadline of five. The wait is abortable
and is aborted when the member's turn ends however it ended: the run's
deadline rejects the call and walks away from the promise rather than
stopping it, so an answer arriving afterwards would otherwise perform the
action on behalf of a turn nobody is watching. `runUnattended` gives
up on an ask rule, which is right for a routine nobody is watching and wrong
here. When the answer comes back the action is tried once more, carrying the
approval id: the gateway spends an approval by id and fingerprint, so a
retry that presents neither just raises a second question and the person's
Allow pays for nothing. Deny is final and the member is told not to retry.
Nobody answering is not a failure — the member says it is still waiting, the
card stays up, and an answer given late is found by its next attempt.

The count of rooms waiting also goes on the app's icon — through the desktop
shell's `set_badge` command when the app runs in it (`app/src/lib/notifications/shell.ts`
feature-detects `window.__TAURI__`), through `navigator.setAppBadge` in an
installed Chromium window, and the tab title everywhere else. In the shell,
notifications go through the OS centre rather than the webview's own API,
which WKWebView does not provide; they survive the window being hidden behind
other apps, which is the reason a person installs an app at all. A MUTED Bot
still counts there: muting silences the popup, not the fact that something is
waiting. A hidden one does not, because it is not on the roster to be counted.
