# Architecture

LAF Agent combines a React app, a Hono API server, PostgreSQL, AG-UI Bot endpoints, and a governed browser computer. Threads and memory are stored in PostgreSQL by the server itself.

**One VM per person, and one API server process on it.** However many Bots somebody makes, they
share that VM, and nobody else's Bots are on it. That is the decision this whole document rests on
and it is recorded in [laf/deployment-model.md](laf/deployment-model.md) — read that before
arguing with anything here. What follows from it, and shows up repeatedly below: state that only
has to outlive a request and not a restart lives in the server process on purpose, not as a
shortcut, and there is no second replica to reconcile it with.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/architecture-dark.svg">
  <img src="../assets/architecture-light.svg" alt="A turn goes from the app to the server, which sends it to a Bot over AG-UI. Every tool call the Bot makes returns through the gateway, which resolves the target, decides it against the configured policy, records an audit row, and only then acts, or refuses and names the rule. Allowed actions reach the account's computer, one container holding Chromium, logins and a workspace shared by every Bot. Decisions, threads and memory land in PostgreSQL.">
</picture>

Regenerate it with `bun run diagram` after changing anything it shows.

## Services and ports

| Component                | Port                       | Responsibility                                                                                                                              |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`                    | 3010                       | React/Vite interface for channels, Bot chat, live screen, settings, and admin pages.                                                        |
| `server`                 | 3001                       | API, CopilotKit runtime, auth, roles, tenant package, coworkers, channels, routines, policy, audit, credentials, plugins, and components.   |
| `agent-computer`         | 4100                       | Chromium, `/workspace`, browser profile, screenshots, snapshots, and file tools.                                                            |
| `agent-bot`              | 4200                       | The AG-UI endpoint every Bot a person creates runs on.                                                                                      |
| PostgreSQL 17            | 5432                       | Product data, threads, memory, audit rows, credentials, policy, grants, channels, components, and routines.                                 |

`scripts/start.sh` starts PostgreSQL, `agent-computer`, and `agent-bot` through Docker Compose, then starts `server` and `app` on the host.

## Runtime flow

1. The app opens a channel or direct Bot session.
2. The server resolves the signed-in actor and selected coworker.
3. CopilotKit runtime sends the turn to that Bot's AG-UI endpoint. Only Bots a package shipped are
   `built_in`; everything anybody makes is `remote_ag_ui` and is answered by `agent-bot`.
4. The surface registers available frontend tools: browser tools, MCP tools, and components granted to that Bot.
5. Acting browser/file/MCP calls return to the server for authorization and audit.
6. The server streams results back to the app and persists the thread in PostgreSQL.

Per-run settings — the Bot's effort, and anything else decided at the moment of asking — travel as
AG-UI `forwardedProps` through the middleware in `server/src/copilot.ts`. That is the one seam every
path goes through, so a setting wired anywhere else reaches one path and not the others.

Two paths do not have a browser watching them and run entirely on the server: a room's turn
(`server/src/rooms/`) and a routine's unattended run (`server/src/runner/unattended.ts`). Both call
the same gateway with the same policy, grants, audit rows and approval registry underneath. A tab
that closes mid-turn no longer kills the turn.

## Browser action governance

The computer itself does not decide policy. The server gateway is the action boundary:

1. resolve the target from the server-held snapshot or request subject;
2. evaluate the current action policy;
3. write an audit row for the decision;
4. call the computer only when the decision forwards;
5. write a second audit row if a forwarded action fails.

Policy rules can inspect:

- `tool.name`
- `intent`
- `bot.id`
- `actor.id`
- `page.url`, `page.host`
- `element.ref`, `element.role`, `element.name`, `element.type`
- `key`
- `submit`, true when a type call will press Enter when it has finished
- `file.path`, `file.name`, `file.extension`
- `mcp.server`, `mcp.tool`, `mcp.effect`
- `repeat.count`

`repeat.count` is how many times that Bot has just made that exact call, counting the one being
decided. The gateway keys it on the tool plus the ref, key, file path, or target URL, over a sliding
window that defaults to three minutes and is set by `COMPUTER_REPEAT_WINDOW_MS`. Crossing 3, 10, or
25 writes one `computer.action_repeated` row each; the detector itself never refuses anything, so
`repeat.count >= 10` in `deny` is what stops a Bot going in circles. The count is held in memory by
the one server process, which is the whole of it on a deployment shaped like this one, and it
covers the browser and the workspace only: a call to another server's tools over MCP always reports
one.

Rules use CEL expressions plus case-insensitive `contains()` and `matches()`.
Rules are evaluated in three lists, in order: `deny`, then `ask`, then `allow`.
The policy engine fails closed: a missing or empty policy permits nothing, a
broken deny rule denies, a broken ask rule asks, and a broken allow rule does not
permit. LAF Agent's shipped startup default is explicit: `deny: []`, `ask: []` and
`allow: ["true"]`, unless `AGENT_COMPUTER_POLICY` or a saved administrator policy
replaces it. A malformed configured policy stops server startup.

An `ask` match stops the action and puts it in front of a person in the
conversation, then carries on with the same call if they allow it. The pending
question lives in the server process, is bound to a fingerprint of the exact
action it was raised for, and is single use, so an approval cannot be replayed
against a different one. Answering writes `approval.granted` or `approval.denied`
under the answering person's own actor, separately from the action row, and the
question itself writes `approval.requested` when it is raised. In `dry-run` an
ask is recorded and interrupts nobody.

The same three lists judge a Bot's MCP tool calls, `ask` included: a rule such as
`intent == "write_tool" && mcp.server == "jira"` stops the call and asks rather
than refusing it, and the question is answered on the same surface, `POST
/api/approvals/:botId/:approvalId`, as one raised by a click. That surface is
mounted whether or not a computer is configured, because a question nobody can be
shown is worse than a rule that never fired.

Pending questions are held in the server process, like the snapshot cache and the
repeat counter. That is the deployment model, not an unfinished piece of work:
there is one process, so the process that raised a question is the process that
is asked about it. Memory is also the right place for a second reason. A pending
question is about a live browser session and a live turn, and a restart takes the
snapshot, the page and the mid-run model with it; a persisted approval would come
back as a grant for an action nobody could still perform, given by somebody who
does not remember giving it. The safe reading of a restart is that every open
question was withdrawn, and the safe way to guarantee that is to keep the
questions somewhere a restart empties (`server/src/computer/approvals.ts`).
A question expires after ten minutes either way.

## Computers

`agent-computer` requires `COMPUTER_TOKEN` and permits only `/health` without it. Docker Compose binds it to `127.0.0.1:4100`.

Every Bot of an account shares the computer at `AGENT_COMPUTER_URL` — the account's desk, by decision (`server/src/computer/assignment.ts`). Files, logins and browser sessions carry between Bots; the boundary is the gateway in front of the computer, not the roster. Five Bots per person, `BOT_SEATS_PER_ACCOUNT`, enforced where a Bot is created so a sixth fails to exist rather than existing and failing to reach a computer.

Within the one container each Bot gets its own Chromium profile. Which Bot a request is for comes
from the `x-openbot-bot-id` header, and the computer **falls back to a default profile** when the
header is absent — so a caller that leaves it off is not talking to no Bot, it is silently talking to
the wrong one, on a blank page belonging to nobody.

## Human control and secrets

Handovers are audited as control events:

- `computer.help_requested`
- `computer.control_taken`
- `computer.control_released`

While a person controls the browser, Bot actions are refused rather than queued.

Secret entry is separate from chat content. The audit trail records that a secret was requested or supplied and the character count, not the secret value.

## Demonstrations and skills

A person can drive the Bot's browser through a task once and keep it. The demonstration recorder
(`server/src/computer/demonstration.ts`) watches the session and `write-up.ts` turns it into a
procedure the person edits, names, and invokes with `/` in the composer.

**The recorder never keeps a value.** Every keystroke in a Bot's browser passes through it, including
passwords, so what it records is that typing happened and into which field — the same rule as the
audit fingerprint. A test serialises a whole record and asserts the password is nowhere in it.

## Coworkers and channels

A coworker is a durable Bot profile:

- `agents` stores runtime identity and endpoint/key reference.
- `agent_profiles` stores name, title, role, owner, visibility, and deletion state.
- `agent_preferences` stores per-user roster state.

A channel is a conversation and a thread mapping. Most hold one coworker; a room holds several, and
its turn runs on the server rather than in the browser. Starting a new channel creates a new thread,
stored in PostgreSQL.

See [laf/coworkers.md](laf/coworkers.md) and [laf/routines.md](laf/routines.md).

## Components

Components are frontend tools a Bot can call instead of answering only in prose.

Sources:

- compiled React components in `app/src/components/gallery/`;
- sandboxed components authored and published from `/admin/playground`.

Governance:

- compiled components are published when first seen by the app catalogue sync;
- sandboxed components are saved as drafts and become usable only after publish;
- every call asks the server whether the component exists, is published, and is not withheld from the Bot;
- component data functions require a separate per-component grant.

The shipped component data functions read the audit trail: `botActivity` and `recentRefusals`.

## MCP and skills

MCP servers and skills share the plugin grant table, but they have different ownership rules.

- MCP tools are admin-governed because they can reach external systems with stored credentials.
- Skills are reusable instructions. A person can create personal skills and attach them only to Bots they own. Administrators create deployment skills.

The curated MCP catalogue is frozen in code (`server/src/plugins/catalogue.ts`) and has two entries:
**Notion** and **Google Drive**. Both are connected as the person asking rather than with a token an
administrator pastes — each person consents for themselves and every call runs on their own grant, so
two people asking the same question get the answers their own accounts can see.

- Notion is the vendor's hosted MCP server. The deployment registers its own OAuth client on first
  connect (RFC 7591), so there is no console paperwork, and Notion has no scope strings at all —
  access is chosen page by page on its consent screen, which means `writeTools` plus the action
  policy are the entire write barrier with nothing vendor-side behind them.
- Google Drive is read-only and goes through Google's GA REST API rather than its MCP server, which
  is gated behind a Workspace developer preview. Tool names match the MCP server's, so the entry can
  be swapped back when that opens up.

An earlier five-vendor catalogue (Atlassian, Box, Slack, Salesforce, ServiceNow) was removed;
[laf/connections.md](laf/connections.md) records why. Custom MCP servers must pass URL checks;
unknown tools and custom-server tools are treated as writes unless positively classified as reads.

Every MCP call checks the grant first, then evaluates the same action policy engine with MCP context, then audits the result.

## Tenant package

`TENANT_PACKAGE_DIR` points at the tenant package. The default is `../tenant/laf`.

Required package files:

- `brand.yaml`
- `model.yaml`

The server validates the package at startup and refuses to start on an invalid one. It once also
declared ready-made Bots and channels and a set of knowledge connectors; a Bot now starts with
nothing set and belongs to the person who made it, and the connector plane never had an adapter
behind it, so all three files are gone.

## Security boundaries

- Server routes enforce auth and roles; admin pages are backed by server-side administrator checks.
- `LAF_DEV_NO_AUTH=true` is local-only and is refused with `NODE_ENV=production`.
- `KEY_ENCRYPTION_KEY` must be a base64-encoded 32-byte value. The example key is refused with `NODE_ENV=production`.
- Credential plaintext is encrypted at rest, never returned by APIs, and redacted from audit events.
- Browser navigation allows `http` and `https`; cloud metadata addresses are refused under every configuration.
- `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` is for local development only.
- `COMPUTER_TOKEN` must be a long random value outside local development.
