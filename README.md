<div align="center">

# LAF Agent

**A Bot you can hand real work to, and actually trust with the access.** It starts knowing nothing and becomes whatever you tell it. It works on a real browser with your logins, and every action it takes is decided before it happens and recorded after.

[**Quick start**](#quick-start) · [**What we changed**](#what-we-changed) · [**Features**](#features) · [**Architecture**](#architecture) · [**Docs**](docs/README.md)

[![CI](https://github.com/LAF-labs/openbot/actions/workflows/ci.yml/badge.svg)](https://github.com/LAF-labs/openbot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Alpha](https://img.shields.io/badge/status-alpha-orange.svg)

</div>

<div align="center">

Give your Bot a name, tell it what you want, and it writes down what it is for.
Watch it work on its own screen, take the wheel when it reaches something it
should not do alone, then hand it back — or show it how the task is done once,
and keep that as something you can ask for by name.

Korean first, for people who do not write software: students, office workers,
people who run a small business, and anyone else.

</div>

> **Alpha, and under active development.** Expect rough edges, and expect things to move.

> **A fork.** LAF Agent is built on [CopilotKit's OpenBot](https://github.com/CopilotKit/openbot) (MIT) and keeps its architecture: AG-UI Bots, one governed gateway, an audit row for everything. What we changed is [below](#what-we-changed). Upstream is synced by picking commits, never by merging — see [the deployment model](docs/laf/deployment-model.md) for why.

## What it is

A Bot is a colleague you can hand a job to. It drives a real browser with your
logins in it, reads the files you give it, looks things up, and keeps a notebook
of what you told it.

**One VM per person, and one Bot on it.** The Bot's profile is a name and a
face; everything else — what it is for included — is settled by talking to it.
The computer, its files, its logins and its browser sessions are that person's
and nobody else's, and the thing that keeps the Bot in bounds is the gateway in
front of the computer. That decision shapes the code, and it is written down in
[`docs/laf/deployment-model.md`](docs/laf/deployment-model.md). (An account made
before 2026-09-24 that had several Bots keeps them, sharing that one computer.)

**It is an app you install.** The engine runs on the VM and
[`desktop/`](desktop/) is a Tauri window onto it, holding no product logic of its
own. The order is the PC app first, then mobile, then the browser as a bonus on
top — the SPA being same-origin is how one codebase reaches all three, not
evidence that the browser comes first.

**One conversation, and the server runs it.** A turn belongs to the server, not
to the window: close the app mid-answer and the Bot goes on, and every window
you open only watches. The conversation is one for life; at the end of each day
the request behind it is cut to a summary, so it stays about a day long.

**It asks who you are, once, and treats the answer as a hint.** 학생, 직장인,
사장님 or 기타 orders the suggestions and sets how the Bot addresses you. It
never hides a screen or a feature.

**You do not choose a model.** The deployment serves one. What you choose is how
hard the Bot thinks before it answers — quick, balanced or thorough — because how
long you are willing to wait is a question only you can answer.

Anything the Bot does to a browser, a file, an MCP server or a component goes
through one gateway that decides it and records it. That is the difference
between an agent that can use your tools and an agent you can let near them.

## What we changed

Everything in this table is ours. The rest of this README describes the inherited
architecture, kept and still running.

| | |
| --- | --- |
| **A blank Bot, and onboarding** | No shipped personas. A first run that ends with one Bot of your own, and one question about who you are that only ever orders things. |
| **A Bot shapes itself** | `update_profile` and `manage_routine` — it writes its own name, its job, how hard it thinks and the routines it runs, from inside the conversation. It cannot reach the rule that decides whether it gets asked about. |
| **The server owns the turn** | A conversation's turn runs on the server and every window watches it: a stop, a reload, a second device and a restart all find the same turn. |
| **Suggestions, not a catalogue** | Jobs to start from, dealt a handful at a time and ordered by who you said you are. |
| **Answering a boundary for good** | `Always allow`, scoped to a site, a file or a tool — and the scope is on the button, so what you agree to is what happens. |
| **"Do not ask me about…"** | A sentence you write once; a model applies it to each stopped action. Everything it lets through is recorded as seen by nobody. |
| **One switch over both** | A deployment can refuse to have its boundary settled without a person, and it covers both of the above. |
| **Teaching by demonstration** | Do the task once in the Bot's browser. It is written up as a procedure you edit, name, and invoke with `/`. It never records what you typed. |
| **Routines, 소식 and 목표** | An instruction and a clock. A routine runs with the Bot's tools, through the same gateway, and reports into the conversation or onto 소식; a goal is something a routine keeps checking. |
| **Files in, files out** | Attach a sheet, a PDF or a photo up to 10 MB and the Bot reads it; what it makes is handed back on a card and kept on 만든 것. |
| **Looked up, not browsed** | The web, the weather (기상청, with its source said) and public notices come back in a second through tools on the deployment's own keys, instead of minutes in a browser. Where it is sure what a message wants — today's weather, schedule or new mail — the server fetches it before the model is asked. |
| **Connected as the person asking** | Notion, Canva, Google Drive, Google Sheets, Gmail, Google Calendar, Google Business Profile, Cafe24 and Kakao's PlayMCP, each person consenting for themselves, so the answers are the ones their own account can see. |
| **A tool's words are consented to** | A vendor's tool that was added after the service was connected, or whose description changed, is held back until a person has read it on 관리 → 플러그인 — and the Bot says a tool is waiting there, rather than that it does not exist. The adapters that ship in this repository are not a vendor's: their definitions arrive with the release and are recorded as that. |
| **Where you are** | The place you said, else your device's (rounded to about a kilometre), else Seoul without asking — and the Bot's browser is told the same, so a site does not take the VM's address for yours. |
| **It tells you when it is out of date** | An open window notices a newer build on the server and offers one press, never mid-turn. |
| **Effort** | The one model setting, per Bot, carried into every run — chat and routines. |
| **Korean first** | Every user-facing string, enforced by a test. |
| **One VM per person** | The deployment decides the architecture, not the other way round. |

## Built on AG-UI

A Bot is an endpoint speaking [AG-UI](https://github.com/ag-ui-protocol/ag-ui), the open protocol for agent-to-user interaction, and the governance rides the protocol rather than a framework. Every Bot a person makes is answered by this repository's own endpoint, `agent-bot`, and on a hosted deployment that is the only one there is. On a developer's stack an agent built with LangGraph, Mastra, CrewAI, Pydantic AI, Google ADK or written by hand can be put in its place and arrives the same way — see [Bring your own agent](#bring-your-own-agent).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img src="assets/architecture-light.svg" alt="You talk to the server, which sends the turn to a Bot over AG-UI. Every tool call the Bot makes comes back through the gateway, which resolves the target, decides it against your policy, records an audit row, and only then acts, or refuses and names the rule. Allowed browser and file actions reach the account's computer — one container with its own Chromium, logins and workspace, shared by every Bot you make. Decisions, threads and memory land in PostgreSQL.">
</picture>

## Requirements

- Docker, for PostgreSQL, the Bot's computer, and the Bot endpoint.
- [Bun](https://bun.sh) 1.3+, for the app and API server.
- A model key: `OPENAI_API_KEY`, or any endpoint speaking the same API via `OPENAI_BASE_URL`.

## Quick start

1. Create `.env`:

   ```sh
   cp .env.example .env
   ```

2. Fill the required values:

   - `OPENAI_API_KEY` — or point `OPENAI_BASE_URL` at any endpoint speaking the same API.

   Threads and memory are stored in PostgreSQL; no external thread service is
   involved. The example `KEY_ENCRYPTION_KEY` is public and fine locally;
   generate your own with:

   ```sh
   openssl rand -base64 32
   ```

3. Install and run:

   ```sh
   bun install
   bash scripts/start.sh
   ```

4. Open <http://localhost:3010>.

`scripts/start.sh` starts Docker services, applies migrations, starts the API server on port 3001, starts the app on port 3010, and checks that the services answer their own health routes before printing next steps.

## Try it

- Ask your Bot: `Open news.ycombinator.com and tell me the top story.`
- Ask it to fill out <https://httpbin.org/forms/post>, then inspect `/admin/audit`.
- Open `/admin/boundaries`, add a deny rule or preset, and retry the same browser action.
- Attach a spreadsheet and ask what is in it.
- Give it a routine on `/routines` and press Run now.

## Main surfaces

| Route                         | Purpose                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `/welcome`                    | First run: who you are, and one Bot of your own.                                        |
| `/`, `/channel/:id`           | The conversation: talk to the Bot, watch its screen, take the wheel, answer what it asks. |
| `/feed`                       | 소식 — what the Bot's routines found worth telling you.                                  |
| `/ideas`                      | 아이디어 — jobs to start from.                                                            |
| `/goals`                      | 목표 — what you are working towards, and how it is going.                                 |
| `/made`                       | 만든 것 — every file, chart and card the Bot has handed you.                              |
| `/notebook`                   | 수첩 — what the Bot remembers about you, to read, correct and forget.                    |
| `/skills`                     | Skills — including the ones recorded by showing the Bot how a task is done.             |
| `/routines`                   | An instruction and a clock. Create, enable, run now, and read what happened.            |
| `/approve/:id`                | One question from the Bot, answered from a notification.                                |
| `/settings`                   | Your preferences, your account, your data (download it, delete it).                     |
| `/settings/connected-accounts`| Connections: every service and site the Bot works with, switched on and off in one list. |
| `/help`                       | Help, and a box that reaches the people who run the product.                            |
| `/admin`                      | Where the operator surfaces below are listed.                                           |
| `/admin/boundaries`           | Configure browser/file/MCP action policy.                                               |
| `/admin/audit`                | Review permitted, refused, and failed actions.                                          |
| `/admin/computers`            | View, stop, and reset computers.                                                        |
| `/admin/credentials`          | Store write-only encrypted credentials.                                                 |
| `/admin/bots`                 | A Bot answered by your own AG-UI endpoint — on a developer's stack only.                |
| `/admin/components`           | Publish components and govern which Bots may use them.                                  |
| `/admin/playground`           | Draft and publish sandboxed components in the browser.                                  |
| `/admin/plugins`              | Configure MCP servers, MCP grants, and deployment skills.                                |
| `/sign`                       | Sign in, when the deployment has authentication configured.                             |

## Features

- **One computer per account**: the Bot works on your computer — its files, its logins, its browser sessions. On an older account with several Bots they all share it; Bots are not a security boundary, the gateway in front of the computer is.
- **The gateway is the only way in**: it resolves the target from a server-held snapshot, evaluates the policy, writes the audit row, and only then calls the computer. There is no path that acts without the record existing first.
- **CEL policy, fail closed**: rules can inspect `tool.name`, `intent`, `bot.id`, `actor.id`, `page.url`, `page.host`, `element.*`, `key`, `submit`, `file.*`, `mcp.*` and `repeat.count`. Deny is evaluated before allow, a missing policy permits nothing, and a broken rule refuses rather than opens.
- **Take the wheel**: a Bot that hits a login wall or a 2FA prompt asks for help. Control is handed over in the same panel and recorded as `computer.help_requested`, `computer.control_taken` and `computer.control_released`. While a person is driving, Bot actions are refused rather than queued.
- **Secrets never enter the transcript**: the trail records that a secret was requested and how long it was, not what it said.
- **Bring your own agent, on a developer's stack**: any AG-UI endpoint is a Bot, on a framework or hand written. Endpoints are validated with the same target checks used for browser navigation, and an auth header is stored write-only. A hosted deployment takes none.
- **Components instead of prose**: compiled React components live in `app/src/components/gallery/`, sandboxed ones are authored in `/admin/playground` and published with no deployment. Every call asks the server whether the component exists, is published, and is not withheld from that Bot. Data functions are granted per component.
- **Governed MCP, connected as the person asking**: the curated catalogue ships Notion (hosted MCP, one-click OAuth — the deployment registers its own client, RFC 7591, so there is no console paperwork), Google Drive (read-only, via an admin-registered OAuth client), Google Sheets, Gmail, Google Calendar, Google Business Profile and Cafe24, Canva and Kakao's PlayMCP (hosted MCP), plus 카카오 알림톡, 나라장터·기업마당, web search and the weather (기상청) on an account or key the fleet holds. For the ones a person connects, each person consents for themselves and calls run on their own grant, so the answers are the ones their own account can see. A vendor's tool that is added after the service was connected, or whose definition changes, is paused until a person has read it on `/admin/plugins`. Until then the Bot is not given the vendor's new text — only that a tool is waiting for review, and where — so it says that rather than that there is none. The adapters in this repository are taken as the release ships them and recorded as that. Custom servers must pass URL checks, and any tool not positively classified as a read is treated as a write. See [docs/laf/connections.md](docs/laf/connections.md) for why the previous five-vendor catalogue was removed.
- **Skills are instructions, not capabilities**: personal skills attach only to Bots their author owns, deployment skills are admin-owned, and both are invoked with `/` in the composer.
- **Show it once**: drive the Bot's browser through a task yourself and the demonstration is written up as a procedure you edit, name and invoke with `/`. The recorder keeps that typing happened and into which field — never a value, passwords included, and a test serialises the whole record to prove it.
- **Turns and routines run on the server**: a conversation's turn belongs to the server and every window watches it; a routine fires on its clock with the Bot's tools underneath the same gateway. Closing the window ends neither.
- **Files**: a sheet, a PDF or a photo up to 10 MB is read once when it arrives and kept with the conversation; what the Bot makes is handed back on a card.
- **An audit trail you can read**: `/admin/audit` lists what was permitted, what was refused and what failed, and every refusal carries the rule that caused it.
- **Credentials encrypted at rest**: stored through `/admin/credentials`, never returned by an API, and redacted from audit events.
- **Loopback by default**: computers bind to `127.0.0.1` and require a per-container token, so nothing reaches a logged-in browser by knowing its port.
- **Durable threads and memory**: conversations and per-Bot memory survive restarts in PostgreSQL, and each deployment stamps the threads it owns.

## Bring your own agent

Any AG-UI endpoint can be a Bot — on a developer's stack, which is one whose API runs with `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true` and has a computer configured. The quick start above is not one until you set that line: `.env.example` ships it commented out, and without it `/admin/bots` is not listed and the server refuses an address for a Bot.

The server validates agent endpoints with the same target checks used for browser navigation. The Bot a person makes runs on `MANAGED_AGENT_AG_UI_URL` (`agent-bot`); there, an administrator can point one at an endpoint of their own from `/admin/bots`.

A hosted deployment takes no endpoint for a Bot, and a server run with `NODE_ENV=production` refuses to start with that line set. Each boot says which kind it is (`botEndpoints` on the `boot` line). The rule is in [CLAUDE.md](CLAUDE.md), under "Every Bot a person creates is remote".

See [docs/configuration.md](docs/configuration.md) and [docs/laf/coworkers.md](docs/laf/coworkers.md).

## Configuration

`.env.example` is the source template. The API server refuses to start without:

- `DATABASE_URL`
- `KEY_ENCRYPTION_KEY`
- `LAF_TOKEN_ENCRYPTION_KEY` (`openssl rand -hex 32`; the example in `.env.example` is public, and production refuses it)
- `MANAGED_AGENT_AG_UI_URL`

Durable threads and memory live in this deployment's own PostgreSQL, and there
is nowhere else they can live: four `INTELLIGENCE_*` variables once pointed them
at CopilotKit's hosted runtime instead, no deployment ever set them, and they
are gone.

Settings worth knowing:

| Variable                             | Use                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `LAF_DEV_NO_AUTH`                    | Admits every request as one fixed administrator, so a laptop needs no OAuth credentials. Local only: with `NODE_ENV=production` the server refuses to start rather than ignoring it. `.env.example` ships it on. |
| `OPENAI_BASE_URL`                    | Answers the OpenAI-shaped calls from somewhere else: a gateway, a proxy. Moves the whole deployment. |
| `BOT_MODEL`                          | The model, read by `agent-bot` and substituted into the tenant package. Sent verbatim.              |
| `COMPUTER_TOKEN`                     | Secret every computer request must present. The computer refuses to start without it.               |
| `AGENT_COMPUTER_POLICY`              | JSON action policy. Malformed JSON stops server startup, and so does the one retired rule `!matches(file.path, "^notes/")` in `ask` or `deny` — the refusal names the rule to write instead. |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Lets a Bot reach this machine's own services, and marks a developer's stack: only there may a Bot be pointed at your own agent. Local only: with `NODE_ENV=production` the server refuses to start with it. `.env.example` ships it off. |
| `TENANT_PACKAGE_DIR`                 | Directory containing tenant YAML. Defaults to `../tenant/laf`.                                       |
| `LAF_NOTIFY_WEBHOOK_URL`             | Where "a Bot is blocked on you" is delivered. Unset, it is a log line.                               |

Full reference — every variable the code actually reads, and nothing it does not:
[docs/configuration.md](docs/configuration.md).

## Architecture

| Service                  | Port                       | Purpose                                                                                          |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `app`                    | 3010                       | React/Vite UI.                                                                                   |
| `server`                 | 3001                       | Hono API, the turn engine, auth, policy, audit, plugins, components, Bots and conversations.     |
| `agent-computer`         | 4100                       | Chromium plus `/workspace` and browser profile.                                                  |
| `agent-bot`              | 4200                       | The AG-UI endpoint every Bot a person creates runs on.                                           |
| PostgreSQL 17            | 5432                       | Product data, threads, memory, policy, audit, credentials, grants, channels, and routines.      |

The server gateway is the product/API path for Bot browser and file tool calls.
It resolves the target, evaluates policy, writes an audit row, and then calls
`agent-computer`. The computer also exposes lower-level token-protected service
endpoints; keep them private and do not use them to bypass the gateway.

More detail: [docs/architecture.md](docs/architecture.md).

## Sign in

`.env.example` ships `LAF_DEV_NO_AUTH=true`, because a fresh clone should run without OAuth
credentials and a consent screen. It is for a laptop and only a laptop: with `NODE_ENV=production`
the server refuses to start rather than quietly running without authentication. A deployment
removes it and declares its providers instead:

```sh
AUTH_PROVIDERS=google      # google, kakao, naver — comma separated
BETTER_AUTH_URL=http://localhost:3001
BETTER_AUTH_SECRET=        # openssl rand -base64 32, at least 32 characters
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

`AUTH_PROVIDERS` is what the sign-in buttons are drawn from — the server publishes it on `GET /api/auth/providers` and the screen asks before it draws — so it must agree with the credentials: a name with no credentials, or credentials nobody declared, stops the server rather than serving a button that posts into an error. Each provider's redirect URI is the origin plus `/api/auth/callback/<provider>`.

A deployment can also sign people in through a shared OIDC broker instead of its own provider apps, as `AUTH_PROVIDERS=laf` plus `LAF_OIDC_ISSUER` and `LAF_OIDC_CLIENT_ID` — a public client with PKCE, so there is no secret to configure. See [docs/laf/deploying.md](docs/laf/deploying.md).

Then set the three that decide who gets in and from where:

- `TRUSTED_ORIGINS` — where the app is served from, `http://localhost:3010` locally. It defaults to `http://localhost:3000`, which is not where `start.sh` serves the app.
- `INITIAL_ADMIN_EMAILS` — the address this deployment belongs to. It becomes the administrator of the 관리 menu the first time it signs in, and it is admitted even if the next line leaves it out.
- `SIGN_IN_ALLOWED_EMAILS` — the door. A deployment belongs to exactly one account: with `NODE_ENV=production` the server refuses to start unless this line and `INITIAL_ADMIN_EMAILS` name one address between them, and sign-in refuses a second person in every environment. Unset on a laptop is an open door, and the boot says so.

Remove `LAF_DEV_NO_AUTH`, then restart: the sign-in screen reads the providers from the running server. The app's generated config carries a copy written when it is built, from `AUTH_PROVIDERS` — or, with that unset locally, from whichever credentials are present alongside `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` — and that copy is only what the screen falls back to when the server cannot answer. Accounts, sessions and roles are stored in the same PostgreSQL database as everything else.

A partial set is refused rather than ignored: the server will not start with `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL` but no client credentials, or with a secret shorter than 32 characters.

## Keeping it to your machine

- `agent-computer` drives a browser holding real logins. `docker-compose.yml` binds it to loopback; leave it there.
- Store credentials through `/admin/credentials`, which encrypts them. Do not put credential values in tenant YAML or in committed files.
- `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` is off unless you set it. Set, it lets a Bot reach services on this machine and lets a Bot be pointed at an agent of your own; leave it off unless you need one of the two.

## Development

The gate. A change is not done until all four pass:

```sh
bun run typecheck
bunx biome lint .
bun run format:check
DATABASE_URL=postgres://openbot:openbot@localhost:55432/openbot bun run test:ci
```

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

Use `bash scripts/start.sh` for the whole stack. Use `bun run dev` only when you want the app and server without the Docker Bots and computers.

## Documentation

[docs/README.md](docs/README.md) indexes all of it. The ones worth naming here:

- [docs/laf/user-guide.md](docs/laf/user-guide.md) — 한국어 사용 설명서, for the person using it rather than building it
- [docs/laf/deployment-model.md](docs/laf/deployment-model.md) — one VM per person, and everything that follows from it. The decision record
- [docs/laf/deploying.md](docs/laf/deploying.md) — how one is actually stood up, and what goes wrong at each step
- [docs/architecture.md](docs/architecture.md), [docs/configuration.md](docs/configuration.md), [docs/development.md](docs/development.md) — inherited from upstream and kept true to what this fork runs
- [CLAUDE.md](CLAUDE.md) — how to work in this repository
- [AGENTS.md](AGENTS.md) — where Codex starts a review; it holds no rules of its own and sends the reviewer to CLAUDE.md

## Credits

Built on [CopilotKit's OpenBot](https://github.com/CopilotKit/openbot) (MIT), whose architecture this
fork keeps: AG-UI Bots, one governed gateway, an audit row for everything.

Two other products were read closely and are credited where they were followed, in the commits and
in the comments:

- **xAI's Grok Bot** — the one-VM-per-account shape, and the notification rules, which were read
  out of its shipped bundle and copied rather than re-derived, so that mute, hidden and throttle are
  written once and cannot drift apart. (Group rooms, whose turn ran on the server the way its did,
  were removed on 2026-09-24; a one-to-one turn runs on the server now for reasons of its own.)
- **Nous Research's Hermes Agent** — one chat for life with the session behind it cut each day
  (`server/src/context/day-close.ts`), and the shape of a routine's prompt. (A handoff between Bots
  that landed in the answering Bot's own conversation followed its Bot Mode, and went with the rooms.)

No code was taken from either. What was taken was a decision each of them had already made well,
measured against what was here before it was adopted. Bot avatars used to be third-party character
art and carried their own attribution; they are generated here now
(`app/src/lib/avatar/bot-avatar.ts`), so nothing in this repository is somebody else's work.

## Contributing

- Read [CLAUDE.md](CLAUDE.md) first. It is short, and most of it is there because something went wrong once.
- Open an issue or coordinate before starting substantial work.
- Keep changes focused and update docs when setup, configuration, architecture, or user behavior changes.
- Keep secrets, service-account JSON, customer data, and local transcripts out of the repository.
- Run the checks in [Development](#development) before opening a pull request.

## License

[MIT](./LICENSE) © CopilotKit
