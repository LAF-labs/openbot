<div align="center">

# LAF Agent

**Bots you can hand real work to, and actually trust with the access.** Each one starts knowing nothing and becomes whatever you tell it. It works on a real browser with your logins, and every action it takes is decided before it happens and recorded after.

[**Quick start**](#quick-start) · [**What we changed**](#what-we-changed) · [**Features**](#features) · [**Architecture**](#architecture) · [**Docs**](docs/README.md)

[![CI](https://github.com/LAF-labs/openbot/actions/workflows/ci.yml/badge.svg)](https://github.com/LAF-labs/openbot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![Alpha](https://img.shields.io/badge/status-alpha-orange.svg)

</div>

https://github.com/user-attachments/assets/535ef7ee-1631-4a69-b839-564c56cf90b4

<div align="center">

Make a Bot with nothing but a name, tell it what you want, and it writes down
what it is for. Watch it work on its own screen, take the wheel when it reaches
something it should not do alone, then hand it back — or show it how the task is
done once, and keep that as something you can ask for by name.

</div>

> **Alpha, and under active development.** Expect rough edges, and expect things to move.

> **A fork.** LAF Agent is built on [CopilotKit's OpenBot](https://github.com/CopilotKit/openbot) (MIT) and keeps its architecture: AG-UI Bots, one governed gateway, an audit row for everything. What we changed is [below](#what-we-changed). Upstream is synced by picking commits, never by merging — see [the deployment model](docs/laf/deployment-model.md) for why.

## What it is

A Bot is a colleague you can hand a job to. It has a browser of its own with
your logins in it, it can read and write files, and it keeps working when you
close the window.

**One VM per person.** However many Bots you make, they share it — and nobody
else's Bots are on it. That decision shapes the code, and it is written down in
[`docs/laf/deployment-model.md`](docs/laf/deployment-model.md).

**A Bot starts blank.** No personas ship in the box. You make one with a name,
and either say what it is for or leave it to ask you itself. Up to five.

**You do not choose a model.** The deployment serves one. What you choose is how
hard a Bot thinks before it answers — quick, balanced or thorough — because how
long you are willing to wait is a question only you can answer.

Anything a Bot does to a browser, a file, an MCP server or a component goes
through one gateway that decides it and records it. That is the difference
between an agent that can use your tools and an agent you can let near them.

## What we changed

Everything below is ours; the rest of this README describes what we inherited
and still runs.

| | |
| --- | --- |
| **Blank Bots, and onboarding** | No shipped personas. A first run that ends with one Bot of your own. |
| **A Bot shapes itself** | `update_state` — it writes its own name, its job, its routines, and how hard it thinks, from inside the conversation. |
| **Suggestions, not a catalogue** | Thirty-two jobs to start from, dealt a handful at a time, one per kind of work. |
| **Answering a boundary for good** | `Always allow`, scoped to a site, a file or a tool — and the scope is on the button, so what you agree to is what happens. |
| **"Do not ask me about…"** | A sentence you write once; a model applies it to each stopped action. Everything it lets through is recorded as seen by nobody. |
| **One switch over both** | A deployment can refuse to have its boundary settled without a person, and it covers both of the above. |
| **Teaching by demonstration** | Do the task once in the Bot's browser. It is written up as a procedure you edit, name, and invoke with `/`. It never records what you typed. |
| **Effort** | The one model setting, per Bot, carried into every run — chat, rooms and routines. |
| **Korean first** | Every user-facing string, enforced by a test. |

## Built on AG-UI

A Bot is any endpoint speaking [AG-UI](https://github.com/ag-ui-protocol/ag-ui), the open protocol for agent-to-user interaction, so LAF Agent is not tied to a framework and neither are you. Agents built with LangGraph, Mastra, CrewAI, Pydantic AI, Google ADK or written by hand all arrive the same way, and the governance rides the protocol rather than the framework.

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

- Open `/bot` and ask: `Open news.ycombinator.com and tell me the top story.`
- Ask the Bot to fill out <https://httpbin.org/forms/post>, then inspect `/admin/audit`.
- Open `/admin/boundaries`, add a deny rule or preset, and retry the same browser action.
- Create a coworker from `/agents`, give it a standing role, and start a channel with it.

## Main surfaces

| Route                | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `/`                  | Start and browse channels.                                         |
| `/agents`            | Create, edit, duplicate, hide, delete, and launch coworkers.       |
| `/channel/:id`       | Converse with one coworker and view its live screen/profile panel. |
| `/bot`               | Direct chat with a Bot; `?agent=<id>` selects one.                 |
| `/skills`            | Create and enable personal skills.                                 |
| `/settings`          | User preferences.                                                  |
| `/admin/credentials` | Store write-only encrypted credentials.                            |
| `/admin/computers`   | View, stop, and reset Bot computers.                               |
| `/admin/boundaries`  | Configure browser/file/MCP action policy.                          |
| `/admin/components`  | Publish components and govern which Bots may use them.             |
| `/admin/playground`  | Draft and publish sandboxed components in the browser.             |
| `/admin/plugins`     | Configure MCP servers, MCP grants, and deployment skills.          |
| `/admin/audit`       | Review permitted, refused, and failed actions.                     |

## Features

- **One computer per account**: every Bot you make shares your computer — files, logins and browser sessions carry from one Bot to the next, which is what lets them hand work to each other. Bots are not a security boundary; the gateway in front of the computer is.
- **The gateway is the only way in**: it resolves the target from a server-held snapshot, evaluates the policy, writes the audit row, and only then calls the computer. There is no path that acts without the record existing first.
- **CEL policy, fail closed**: rules can inspect `tool.name`, `intent`, `bot.id`, `actor.id`, `page.url`, `page.host`, `element.*`, `key`, `file.*` and `mcp.*`. Deny is evaluated before allow, a missing policy permits nothing, and a broken rule refuses rather than opens.
- **Take the wheel**: a Bot that hits a login wall or a 2FA prompt asks for help. Control is handed over in the same panel and recorded as `computer.help_requested`, `computer.control_taken` and `computer.control_released`. While a person is driving, Bot actions are refused rather than queued.
- **Secrets never enter the transcript**: the trail records that a secret was requested and how long it was, not what it said.
- **Bring your own agent**: any AG-UI endpoint is a Bot, on a framework or hand written. Endpoints are validated with the same target checks used for browser navigation, and an auth header is stored write-only.
- **Components instead of prose**: compiled React components live in `app/src/components/gallery/`, sandboxed ones are authored in `/admin/playground` and published with no deployment. Every call asks the server whether the component exists, is published, and is not withheld from that Bot. Data functions are granted per component.
- **Governed MCP, connected as the person asking**: the curated catalogue ships Notion (hosted MCP, one-click OAuth — the deployment registers its own client, RFC 7591, so there is no console paperwork) and Google Drive (read-only, via an admin-registered OAuth client). Each person consents for themselves and calls run on their own grant, so two people asking the same question get the answers their own accounts can see. Custom servers must pass URL checks, and any tool not positively classified as a read is treated as a write. See [docs/laf/connections.md](docs/laf/connections.md) for why the previous five-vendor catalogue was removed.
- **Skills are instructions, not capabilities**: personal skills attach only to Bots their author owns, deployment skills are admin-owned, and both are invoked with `/` in the composer.
- **An audit trail you can read**: `/admin/audit` lists what was permitted, what was refused and what failed, and every refusal carries the rule that caused it.
- **Credentials encrypted at rest**: stored through `/admin/credentials`, never returned by an API, and redacted from audit events.
- **Loopback by default**: computers bind to `127.0.0.1` and require a per-container token, so nothing reaches a logged-in browser by knowing its port.
- **Durable threads and memory**: conversations and per-Bot memory survive restarts in PostgreSQL, and each deployment stamps the threads it owns.

## Bring your own agent

Any AG-UI endpoint can be a Bot.

From `/agents`, create a coworker with:

- name, title, and role description;
- private or public visibility;
- optional AG-UI endpoint;
- optional write-only authorization header.

The server validates agent endpoints with the same target checks used for browser navigation. If no custom endpoint is set, product-created coworkers use `MANAGED_AGENT_AG_UI_URL`.

Every coworker is made this way. The tenant package could once declare some of its own; it ships
none, and a Bot belongs to the person who made it.

See [docs/configuration.md](docs/configuration.md) and [docs/coworkers.md](docs/coworkers.md).

## Configuration

`.env.example` is the source template. The API server refuses to start without:

- `DATABASE_URL`
- `KEY_ENCRYPTION_KEY`
- `MANAGED_AGENT_AG_UI_URL`

Durable threads and memory live in this deployment's own PostgreSQL, and there
is nowhere else they can live: four `INTELLIGENCE_*` variables once pointed them
at CopilotKit's hosted runtime instead, no deployment ever set them, and they
are gone.

Settings worth knowing:

| Variable                             | Use                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `LAF_DEV_NO_AUTH`                | Admits every request as one administrator. How it runs today.             |
| `OPENAI_BASE_URL`                    | Answers the OpenAI-shaped calls from somewhere else: a gateway, a proxy.  |
| `ANTHROPIC_BASE_URL`, `GOOGLE_GENERATIVE_AI_BASE_URL` | The same, for those two APIs.            |
| `COMPUTER_TOKEN`                     | Secret every Bot computer request must present. `start.sh` sets one.      |
| `AGENT_COMPUTER_POLICY`              | JSON action policy. Malformed JSON stops server startup.                  |
| `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` | Lets a Bot reach this machine's own services.                             |
| `TENANT_PACKAGE_DIR`                 | Directory containing tenant YAML. Defaults to `../tenant/laf`.            |
| `LAF_NOTIFY_WEBHOOK_URL`             | Where "a Bot is blocked on you" is delivered. Unset, it is a log line.     |

Full reference: [docs/configuration.md](docs/configuration.md).

## Architecture

| Service                  | Port                       | Purpose                                                                                          |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `app`                    | 3010                       | React/Vite UI.                                                                                   |
| `server`                 | 3001                       | Hono API, CopilotKit runtime, auth, policy, audit, plugins, components, coworkers, and channels. |
| `agent-computer`         | 4100                       | Chromium plus `/workspace` and browser profile.                                                  |
| `agent-bot`              | 4200                       | The AG-UI endpoint every Bot a person creates runs on.                                           |
| PostgreSQL 17            | 5432                       | Product data, threads, memory, policy, audit, credentials, grants, channels, and routines.      |

The server gateway is the product/API path for Bot browser and file tool calls.
It resolves the target, evaluates policy, writes an audit row, and then calls
`agent-computer`. The computer also exposes lower-level token-protected service
endpoints; keep them private and do not use them to bypass the gateway.

More detail: [docs/architecture.md](docs/architecture.md).

## Sign in

`LAF_DEV_NO_AUTH` is the default because it needs no OAuth credentials and no consent screen. To sign in for real instead, declare the providers and set the values that back them:

```sh
AUTH_PROVIDERS=google      # google, kakao, naver — comma separated
BETTER_AUTH_URL=http://localhost:3001
BETTER_AUTH_SECRET=        # openssl rand -base64 32, at least 32 characters
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

`AUTH_PROVIDERS` is what the sign-in buttons are compiled from, so it must agree with the credentials: a name with no credentials, or credentials nobody declared, stops the server rather than serving a button that posts into an error. Each provider's redirect URI is the origin plus `/api/auth/callback/<provider>`.

A deployment can also sign people in through a shared OIDC broker instead of its own provider apps, as `AUTH_PROVIDERS=laf` plus `LAF_OIDC_ISSUER` and `LAF_OIDC_CLIENT_ID` — a public client with PKCE, so there is no secret to configure. See [docs/laf/deploying.md](docs/laf/deploying.md).

Then set the two that decide who gets in and from where:

- `TRUSTED_ORIGINS` — where the app is served from, `http://localhost:3010` locally. It defaults to `http://localhost:3000`, which is not where `start.sh` serves the app.
- `INITIAL_ADMIN_EMAILS` — comma separated. An address listed here becomes an administrator the first time it signs in; everybody else becomes a user.
- `SIGN_IN_ALLOWED_EMAILS` — comma separated, and the actual door: unset, anybody the provider authenticates gets an account. Admin emails are admitted on top of it, so listing staff cannot lock the owner out.

Remove `LAF_DEV_NO_AUTH`, then restart: the sign-in buttons are written into the app's generated config when it is built, from `AUTH_PROVIDERS` — or, with that unset locally, from whichever credentials are present alongside `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`. Accounts, sessions and roles are stored in the same PostgreSQL database as everything else.

A partial set is refused rather than ignored: the server will not start with `BETTER_AUTH_SECRET` or `BETTER_AUTH_URL` but no client credentials, or with a secret shorter than 32 characters.

## Keeping it to your machine

- `agent-computer` drives a browser holding real logins. `docker-compose.yml` binds it to loopback; leave it there.
- Store credentials through `/admin/credentials`, which encrypts them. Do not put credential values in tenant YAML or in committed files.
- `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS` lets a Bot reach services on this machine. Unset it if you would rather it could not.

## Development

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

Use `bash scripts/start.sh` for the whole stack. Use `bun run dev` only when you want the app and server without the Docker Bots and computers.

## Documentation

Ours:

- [docs/laf/deployment-model.md](docs/laf/deployment-model.md) — one VM per person, and what follows from it
- [docs/laf/deploying.md](docs/laf/deploying.md) — how one is actually stood up, and what goes wrong at each step
- [docs/laf/onboarding-guide.md](docs/laf/onboarding-guide.md)
- [docs/laf/mcp-contract.md](docs/laf/mcp-contract.md)
- [CLAUDE.md](CLAUDE.md) — how to work in this repository

Inherited, and still accurate:

- [docs/README.md](docs/README.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/development.md](docs/development.md)
- [docs/coworkers.md](docs/coworkers.md)

## Contributing

- Read [CLAUDE.md](CLAUDE.md) first. It is short, and most of it is there because something went wrong once.
- Open an issue or coordinate before starting substantial work.
- Keep changes focused and update docs when setup, configuration, architecture, or user behavior changes.
- Keep secrets, service-account JSON, customer data, and local transcripts out of the repository.
- Run the checks in [Development](#development) before opening a pull request.

## License

[MIT](./LICENSE) © CopilotKit
