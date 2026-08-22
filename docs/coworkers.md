# Coworkers

A coworker is a Bot with a durable profile and standing role. The role is sent with every run so the user does not have to restate the job in each channel.

## Data model

| Piece                | Table                           | Purpose                                                               |
| -------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Runtime agent        | `agents`                        | AG-UI endpoint and optional key reference.                            |
| Profile              | `agent_profiles`                | Name, title, role, avatar seed, owner, visibility, and soft deletion. |
| Personal roster      | `agent_preferences`             | Per-user hidden state.                                                |
| Channel              | `channels`                      | Conversation membership and coworker binding.                         |
| Intelligence mapping | `intelligence_channel_mappings` | Channel-to-thread mapping.                                            |

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

Starting a channel creates a new conversation and Intelligence thread. Two channels with the same coworker stay separate.

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

It rides the socket the roster already keeps open
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
