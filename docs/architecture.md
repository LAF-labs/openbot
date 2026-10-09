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

1. The app opens the conversation with the Bot. The surface registers the tools it can draw —
   browser tools, MCP tools, and components granted to that Bot — and says which, with their
   schemas, when it hands a message over (`POST /api/turns/:thread`).
2. The server resolves the signed-in actor and the Bot, and runs the turn itself
   (`server/src/turns/engine.ts`): it asks that Bot's AG-UI endpoint, carries out each tool call
   (`server/src/turns/chat-tools.ts`) and asks again with the result. Only Bots a package shipped
   are `built_in`; everything anybody makes is `remote_ag_ui` and is answered by `agent-bot`.
3. Acting browser/file/MCP calls go through the server's gateway for authorization and audit.
   Where a person is needed — an approval, a request for help, a choice — the turn waits on the
   server until somebody answers from any window.
4. Every window of the conversation watches the same numbered frames (`GET /api/turns/:thread/stream`)
   and draws them; one that reopens catches up from its cursor. The thread is persisted in PostgreSQL.

Per-run settings — the Bot's effort, and anything else decided at the moment of asking — travel as
AG-UI `forwardedProps` through the middleware in `server/src/copilot.ts`. That is the one seam every
path goes through, so a setting wired anywhere else reaches one path and not the others.

No path needs a browser watching it: a conversation's turn (`server/src/turns/`) and a routine's
unattended run (`server/src/runner/unattended.ts`) both run entirely on the server and call the same
gateway with the same policy, grants, audit rows and approval registry underneath. A tab that closes
mid-turn does not end the turn. Until 2026-10-05 a window could drive the turn instead
(`SERVER_TURNS=off`): the page ran each tool call and started the next run with the result. That
path was removed, and a deployment that still sets `SERVER_TURNS=off` refuses to start.

## Browser action governance

The computer itself does not decide policy. The server gateway is the action boundary:

1. resolve the target from the server-held snapshot or request subject;
2. evaluate the current action policy;
3. write an audit row for the decision;
4. call the computer only when the decision forwards;
5. write a second audit row if a forwarded action fails.

Policy rules can inspect:

- `tool.name`
- `intent` — what the act is, whichever tool makes it: `navigate`, `activate` (a press, and a key
  that activates), `type`, `read`, `upload`, `read_file`, `write_file`, `list_files`,
  `run_script`, and `fill_secret`: the Bot ASKING A PERSON to put a value into a field themselves
  (`computer_request_secret`). The last is its own intent and not `type` on purpose. The shipped
  policy refuses a Bot typing into a password field (`intent == "type"` and the field's type or
  name), and that field is exactly where a person's value is for; a rule about asking is written
  `intent == "fill_secret"` — with `page.host` for a site, `element.name` for a field. What such a
  rule decides is whether the Bot may ask. The value is the person's, typed into a masked box,
  and no rule stands between a person and a field they were shown; what the gateway gives that
  typing is the field — it goes into the one the request was judged on, or nowhere
- `bot.id`
- `actor.id`
- `page.url`, `page.host` — of the page an act is made ON: a press, typing, a key, a scroll, a
  tab switch, an upload (which hands a file to the page), and for a navigation the page being
  opened. BLANK for an act that has nothing to do with any page, whatever the browser is showing:
  a read, a write or a listing of the Bot's own folder (`read_file`, `write_file`, `list_files`)
  and a run of a script. So a rule about a site that says nothing of `intent` —
  `page.host == "bank.example"` — decides what is done on that site and does NOT fire on a file
  act made while the browser is parked there; until 2026-10-07 it did. A rule about files is
  written about `file`. No rule a deployment starts with is affected: the one that reads
  `page.host` says `intent == "activate"` as well (`MONEY_HOST_RULE`, `shared/policy-rules.ts`),
  and the one preset on the boundaries screen that reads it says `intent == "navigate"`. The
  same blank is what a yes or a No about a file is bound to and what its rows are filed under,
  so neither changes when the browser moves
- `element.ref`, `element.role`, `element.name`, `element.type`
- `key`
- `submit`, true when a type call will press Enter when it has finished
- `file.path`, `file.name`, `file.extension` — of the path as the Bot's computer reads it, not as
  it was written: the ends trimmed, and `.` segments, doubled slashes and a trailing slash gone, so
  `./private/pay.csv `, `private//pay.csv` and `private/pay.csv/.` are all `private/pay.csv` to a
  rule, as they are one file to the computer. A path the computer does not read one way — one with
  a backslash in it, or white space at the edge of its first or last name — is refused before any
  rule is asked (`laf:file_path_refused`). A listing's folder is asked about both as `private`
  and as `private/`, and a rule that matches either name is a rule about the folder: of the two
  answers, the one the lists' own order reaches first stands (deny, ask, allow, and only then
  "no rule allows this")
- `file.folder` — the top-level folder of that path, to the letter: `notes` for
  `notes/2026/a.md`, and empty for a file at the top. A listing's path is itself a folder, so for
  a listing it is the path's first name — `notes` for a listing of `notes`, the same under both
  of the names it is asked about by — and empty for the whole folder. It is empty as well for a
  string the computer refuses as a path (`notes/../x`, `/notes/x`), which is in no folder
- `mcp.server`, `mcp.tool`, `mcp.effect`
- `repeat.count`

`repeat.count` is how many times that Bot has just made that exact call, counting the one being
decided. The gateway keys it on the tool plus the ref, key, file path, or target URL, over a sliding
window that defaults to three minutes and is set by `COMPUTER_REPEAT_WINDOW_MS`. Crossing 3, 10, or
25 writes one `computer.action_repeated` row each; the detector itself never refuses anything, so
`repeat.count >= 10` in `deny` is what stops a Bot going in circles. The count is held in memory by
the one server process, which is the whole of it on a deployment shaped like this one. A call to
another server's tools over MCP goes through the same counter, keyed on the tool alone — its
arguments are not in the key — and crossing a threshold writes `mcp.call_repeated`.

A run of a script the Bot wrote (`runScript`, offered to no Bot yet) is ONE call to this count:
keyed on the script's digest and the files it names, in any order, and not on the time it asked
for. The files it reads and the files it makes are each decided by every rule about their path —
and are NOT counted. To a rule that decides by `repeat.count` on a file's intent a run's read is
a first attempt every time: twelve different scripts over one file are not "the same read twelve
times", and `deny: intent == "read_file" && repeat.count >= 3` does not see them. That is a
known hole and not a design: it is so because a read counted beside its run made the fifth
identical run two questions for one answer, and it stays so only until a run is one question and
its file acts are counted in the file's own history — before any tool offers a run.

Rules use CEL expressions plus case-insensitive `contains()` and `matches()`.
Rules are evaluated in three lists, in order: `deny`, then `ask`, then `allow`.

`contains()` and `matches()` ignore letter case; `==` and `!=` do not. Ignoring it is right for a
rule that forbids — "never click submit" has to catch SUBMIT — and wrong for one that exempts,
because a deployment's disk tells `Notes` from `notes`. A negated `contains()` or `matches()` in
`deny` or `ask` exempts every lettering of a name, and a plain one in `allow` permits every
lettering of it: under `ask: intent == "write_file" && !matches(file.path, "^notes/")` a write to
`Notes/x.md` is not asked about, and lands in a second folder beside `notes/`. To exempt a
folder, compare `file.folder`: `intent == "write_file" && file.folder != "notes"`. The boundaries
screen offered the first form until 2026-10-07. That one expression — exactly it — is no longer
a rule the server takes in `deny` or `ask`: migration 0062 rewrites a stored copy (and moves an
allowance that still stands under it to the new rule), a save that holds it is refused
(`400 laf:policy_rule_retired`, with the rule to write in its place), and a server whose
`AGENT_COMPUTER_POLICY` holds it does not start. Nothing rewrites or refuses a rule somebody
wrote by hand in its shape.

The policy engine fails closed: a missing or empty policy permits nothing, a
broken deny rule denies, a broken ask rule asks, and a broken allow rule does not
permit. LAF Agent's shipped startup default (`server/src/computer/default-policy.ts`)
is explicit: `deny` refuses typing into a password or secret field; `ask` stops for
pressing a button whose label says money, sending, deleting or confirming, pressing
anything on a bank or payment site, uploading a file, and the fifth identical call
in a row; and `allow: ["true"]` permits the rest — unless `AGENT_COMPUTER_POLICY` or
a saved administrator policy replaces it. A malformed configured policy stops server
startup.

A save is made against the boundary it read. `GET /api/computers/policy` hands out the policy
and a `revision` — a digest of that boundary — and `PUT` has to hand the same one back: the
screen that edits the policy sends the whole of it with one thing changed, so a window holding
an older copy would otherwise undo whatever was decided since, the `settleWithoutAsking` switch
included. A save with no revision, or with one that is not the boundary in force, stores nothing
and is answered `409 laf:policy_changed`; the screen then reads the current boundary, shows it
and says so, and does not make the save again by itself. The check and the write are one step
inside the one server process a deployment runs. A save is asked this before it is asked about
the retired rule above: a window whose copy is out of date may hold that rule for no other
reason, and is told its copy is old rather than about a rule nobody typed. (A body that is no
policy at all is told that first — it was never anybody's copy of a boundary.)

An `ask` match stops the action and puts it in front of a person in the
conversation, then carries on with the same call if they allow it. The pending
question lives in the server process, is bound to a fingerprint of the exact
action it was raised for, and is single use, so an approval cannot be replayed
against a different one. Answering writes `approval.granted` or `approval.denied`
under the answering person's own actor, separately from the action row, and the
question itself writes `approval.requested` when it is raised. There is no
`dry-run`: every policy enforces, and a policy that still says `"mode": "dry-run"`
is read as enforced.

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

Every Bot of an account shares the computer at `AGENT_COMPUTER_URL` — the account's desk, by decision (`server/src/computer/assignment.ts`). Files, logins and browser sessions carry between Bots; the boundary is the gateway in front of the computer, not the roster. One Bot per person (2026-09-24, `docs/laf/deployment-model.md`), enforced where a Bot is created so a second fails to exist rather than existing and failing to reach a computer.

Within the one container every Bot shares one Chromium profile, one per deployment, so a site one
Bot signed into is signed in for all of them; each Bot keeps only its own tabs. Which Bot a request
is for comes from the `x-openbot-bot-id` header, and the computer **refuses a request without it**
(400 `laf:bot_header_missing`) on every route but `/health` and `/computers`. It used to fall back to
a default profile, which put a caller that left the header off on the wrong Bot, on a blank page
belonging to nobody.

## Human control and secrets

Handovers are audited as control events:

- `computer.help_requested`
- `computer.control_taken`
- `computer.control_released`

While a person controls the browser, Bot actions are refused rather than queued.

Secret entry is separate from chat content. The audit trail records that a secret was requested or supplied and the character count, not the secret value.

**Nothing keeps what a person typed.** Every click and keystroke a person makes while driving passes
through the server's live-screen proxy (`server/src/live-screen.ts`) on its way to the page,
passwords included, and is forwarded without being read. Taking the wheel no longer has a teaching
door: a Bot is taught a task in words, as a skill (`docs/laf/redesign-2026-10.md` §7).

## Coworkers and channels

A coworker is a durable Bot profile:

- `agents` stores runtime identity and endpoint/key reference.
- `agent_profiles` stores name, title, role, owner, and deletion state.
- `agent_preferences` stores per-user roster state.

A channel is a conversation and a thread mapping, and it holds one coworker. Starting a new channel
creates a new thread, stored in PostgreSQL.

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

The curated MCP catalogue is frozen in code (`server/src/plugins/catalogue.ts`) and has nine entries.
Seven — **Notion**, **Google Drive**, **Google Sheets**, **Gmail**, **Google Calendar**, **Google
Business Profile** and **Cafe24** — are connected as the person asking rather than with a token an
administrator pastes — each person consents for themselves and every call runs on their own grant, so
two people asking the same question get the answers their own accounts can see. The other two,
**카카오 알림톡** and **나라장터·기업마당**, run on an account or key the fleet holds.

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
- `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` is for local development only, and the server refuses to start with it under `NODE_ENV=production`.
- `COMPUTER_TOKEN` must be a long random value outside local development.
