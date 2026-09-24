# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                               |
| -------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | AG-UI endpoint and optional key reference.                            |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed, owner, and soft deletion.             |
| Personal roster      | `agent_preferences`             | Per-user hidden state.                                                |
| Channel              | `channels`                      | Conversation membership and coworker binding.                         |
| Thread mapping       | `channel_threads`               | Channel-to-thread mapping, per person (threads are local).            |

Every coworker is owned by the person who made it. The tenant package used to ship a few that
were public and ownerless; it ships none.

## Standing role

A person has **one Bot**, and its profile is its name and its face (2026-09-24,
`deployment-model.md` "봇은 하나다"). Nothing on the surface asks or shows what
the Bot is for. The system message every run is composed with
(`shared/prompt/index.ts`) names the Bot, and — only when the person has told it
in conversation what to keep doing, which it writes down with `update_profile` —
carries that standing job; with none it says the Bot's work is whatever it is
asked. The `title` column and a job a person typed into the old profile form stay
in the rows; the title is no longer read into the prompt.

## Who can see a Bot

A Bot belongs to the account that made it, and to nobody else. There is no second answer beside
`agent_profiles.owner_user_id` — no visibility field, no `public`, and no role exception: an
administrator does not see, name, address or reach another person's Bot by id. Migration 0042
dropped the `visibility` column and the `agent_visibility` enum that used to say otherwise.

The one Bot that is not somebody's is one the deployment itself ships — `owner_user_id` null,
which `agents.package_id` marks as `built_in`. It belongs to no person, so it is visible to
everyone signed in, and `canManageAgent` refuses to let anybody edit or delete it through the
product. **This package ships none**, so in practice every Bot on a deployment is
`remote_ag_ui`, made by a person, visible only to them, and answered by `agent-bot`.

The rule is written once, in `server/src/agents/profile-policy.ts`: `visibleToActor`, a WHERE
clause for the reads. Filtering happens in the query, never in JavaScript after the row is read.

Driving a Bot — reading its screen, pressing its controls, answering its questions, spending what
its tools hold — is decided by `actorMayDriveBot` (`auth/guards.ts`), and since 2026-09-16 it gives
the same answer: the owner, or a Bot nobody made. It had an administrator exception of its own
after the roster was closed; driving is the stronger half of seeing, so it went too.

## The 관리 menu, and accounts left over

A deployment belongs to one account (`docs/laf/deployment-model.md`, 2026-09-16), and that person
is also the one who uses the 관리 menu. What the menu reaches is the deployment rather than a Bot —
every door that names no Bot:

- the audit trail (`GET /api/admin/audit-events`), `/api/admin/metrics/approvals` and insights —
  Bot **ids**, never a title or a transcript;
- the gateway's deployment-wide rules (`GET`/`PUT /api/computers/policy`);
- what the deployment's one browser holds (`GET /api/computers`, the Computers page). Resetting it
  is still pressed from a row and goes through that row's Bot, so it needs a row whose Bot is theirs;
- every standing allowance on every Bot (`GET /api/approvals/standing`, `DELETE
  /api/approvals/standing/:id`);
- removing an account left over from before the one-account rule
  (`POST /api/admin/users/:id/delete`), which takes its Bots and its rows and lets go of those Bots
  on the shared browser. The logins in that browser stay: they are the person's who stays.

A leftover is a `users` row whose address the sign-in list no longer admits. It acts on nothing: it
cannot sign in, its routines do not run by any door, and nothing is sent to it. Its Bots are still
its own, so the deployment's person cannot see, drive or answer them either; removing the account
is the lever. Restarting the VM drops every open question (the registry is in memory by decision,
`docs/laf/deployment-model.md`) and the runs waiting on them fail.

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

The server requires this setting at startup.

## Register an external AG-UI agent

The tenant package could once declare one in `agents.yaml`; it ships no Bots at all now, and that
file is deleted. Every coworker is made in the product.

Create or edit one from `/agents` and set:

- name;
- title;
- role description;
- optional endpoint;
- optional authorization header.

Endpoint registration uses target checks. Cloud metadata addresses are refused under every configuration. Optional keys are write-only: sending a key stores/replaces it, omitting it keeps the existing key, and APIs do not return it.

`POST /api/agents/test-connection` checks whether an endpoint answers before saving it.

## Capabilities

A coworker's role does not grant capabilities. Capabilities are governed separately:

- browser and file actions go through the computer gateway policy;
- components are published deployment-wide and can be withheld per Bot;
- MCP tools are granted per Bot, from the 관리 menu;
- personal skills can be attached only to Bots the author owns;
- deployment skills are managed from the 관리 menu.

See [architecture.md](../architecture.md).

## The account's computer

An account gets **one virtual computer** and **one Bot** (2026-09-24; it was up
to five, `server/src/computer/assignment.ts`). A second Bot fails to be created
with `laf:account_has_bot`, rather than existing and failing to reach a
computer. An account that already had several keeps them all; the app shows a
short list to reach them only in that case. What stays per-Bot is governance:
policy identity, approvals, repetition counts, credentials and the audit trail
are all keyed on the Bot.

Bots asking each other (`ask_coworker`, `POST /api/agents/:agentId/ask`) was
removed on 2026-09-24 with rooms; it lives in git history.

## Being told, when you are not looking

Every Bot carries one preference per person: `notify`, on by default, editable
from the switch on its profile. What it governs is the browser's own
notification, raised when that Bot speaks in a room you are not reading.

The rule is the one this fork already wrote down for the approval buzz
(`server/src/notifications/notify.ts`): what is blocked on you leads, what
merely happened follows, everything else stays out of the way. So a reply
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

## Rooms

Rooms — one conversation with several Bots in it, run on the server — were
removed on 2026-09-24 when a person came to have one Bot. They live in git
history; the rows a room wrote are kept (`deployment-model.md`, "봇은 하나다").

## The app's icon

The count of conversations waiting goes on the app's icon — through the desktop
shell's `set_badge` command when the app runs in it (`app/src/lib/notifications/shell.ts`
feature-detects `window.__TAURI__`), through `navigator.setAppBadge` in an
installed Chromium window, and the tab title everywhere else. In the shell,
notifications go through the OS centre rather than the webview's own API,
which WKWebView does not provide; they survive the window being hidden behind
other apps, which is the reason a person installs an app at all. A MUTED Bot
still counts there: muting silences the popup, not the fact that something is
waiting. A hidden one does not, because it is not on the roster to be counted.
