# LAF Agent docs

Start with the root [README](../README.md).

## How the thing is built

- [Architecture](architecture.md): one VM per person, services and ports, the gateway that decides
  and records every action, computers, demonstrations, components, MCP, and security boundaries.
- [Configuration](configuration.md): every environment variable the code actually reads — API
  server, `agent-computer`, `agent-bot` — and the tenant package YAML.
- [Development](development.md): local setup, running one service by hand, migrations, the gate, the
  test databases, and the smoke test.

## Ours — decisions, and the shape they force

Everything under `laf/` is this fork's. Everything else in `docs/` is inherited from
[CopilotKit's OpenBot](https://github.com/CopilotKit/openbot) and kept true to what this fork
actually runs.

- [Deployment model](laf/deployment-model.md) (한국어): one VM per person, one server process on it,
  and what follows. **The decision record.** Read it before arguing with a design anywhere else.
- [Deploying](laf/deploying.md): how a VM is actually stood up, and what goes wrong at each step —
  including the three things that must be true before `docker compose up` can work and are not in
  this repository.
- [Connections](laf/connections.md) (한국어): why the catalogue is Notion and Google Drive and not
  the five vendors it used to name, and what it would take to add one back.
- [Coworkers](laf/coworkers.md): durable Bot profiles, the shared computer, coworkers asking each
  other, notifications, and rooms with more than one Bot in them.
- [Routines](laf/routines.md): an instruction, a Bot and a clock — scheduling, records, limits,
  webhook triggers.
- [Model eval pack](laf/eval-pack.md) (한국어): the ritual a candidate model passes before it may
  answer Bots.
- [Redesign 2026-09](laf/redesign-2026-09.md) (한국어): the critical review and the plan it produced.
  A plan, not a description — where it and the code disagree, the code is what runs.

## For the people using it, and the people connecting to it

- [사용 설명서](laf/user-guide.md) (한국어): the manual for a shop owner. No engineering words.
- [MCP contract](laf/mcp-contract.md) (한국어): the contract a customer's developer implements to
  put their own service in front of a Bot.
- [Onboarding guide](laf/onboarding-guide.md) (한국어): the order to do that in.

Do not include credential values, customer data, transcripts, or local-only notes in public docs.
