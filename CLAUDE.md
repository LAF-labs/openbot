# CLAUDE.md — LAF Agent

## What this is

LAF Agent is a **fork of CopilotKit's OpenBot** (`CopilotKit/openbot`, MIT),
turned into an everyday agent for people who do not write software — small
business owners and their staff, in Korean first. A person makes up to five
Bots, each starting with nothing set, and shapes them by talking to them.

The product is a **cloud engine plus an installed app shell**. The engine runs
on a VM; `desktop/` is a Tauri window onto the deployed origin and holds no
product logic.

**The installed app is the product. The order is PC app, then mobile app, then
the browser as a bonus on top.** The repository makes the opposite reading easy
— the shell holds nothing and the SPA is same-origin by construction, so it
looks like the web is the product and the shell is packaging. It is the other
way round: same-origin is how one codebase reaches all three surfaces, not
evidence that the browser comes first. When a change forces a choice between
the two, the shell wins. An earlier local-agent client (`LAF-labs/prime`) was retired in
2026-08; do not resurrect that shape.

## The deployment decides the architecture

**One VM per person.** However many Bots somebody makes, they share that one
VM. Read `docs/laf/deployment-model.md` before arguing with any design here —
it is the decision record, and it is why:

- **One API server process per VM.** No replicas behind a balancer.
- **In-process state is correct, not a shortcut.** The approval registry, the
  repeat counter and the gateway's snapshot cache live in memory on purpose. A
  review saying "this breaks across processes" is answered by that document.
- **Upstream is synced by cherry-pick, never by merge.** Upstream's `#21`
  deletes the foundation everything under boundaries is built on. `472ad43`
  records that refusal; take security and protocol fixes only.
- **Seats are counted per person.** Somebody else's Bots never take yours.

`docs/laf/deploying.md` is how one is actually stood up, including the three
things that must be true before `docker compose up` can work and are not in
this repository: DNS, the cloud's ingress rules, and the host's own firewall.

## Tech

Bun everywhere. Postgres 17 + pgvector. Hono (server), React 19 + Vite (app),
Drizzle, Tailwind 4, Biome, TanStack Router/Query, CopilotKit runtime v2 /
AG-UI, Playwright (the Bot's browser).

```
app/              React SPA
server/           Hono API, boundaries, rooms, routines, the computer gateway
agent-bot/        The AG-UI endpoint every Bot a person creates runs on
agent-computer/   The Bot's browser (Playwright), in a container
desktop/          Tauri shell — a window onto the origin, no product logic
tenant/laf/       The package: model, brand, agents, channels
docs/laf/         Our decisions. Everything else in docs/ is upstream's.
```

Upstream's per-Bot container plane (`supervisor/`, `spire/`, `agent-langgraph/`,
`worker/`) was removed in 2026-08: it contradicted the one-shared-computer
decision and none of it ran. It lives in git history; do not cherry-pick it
back without asking.

## The gate

A change is not done until all four pass:

```bash
bun run typecheck
bunx biome lint .
bun run format:check
DATABASE_URL=postgres://openbot:openbot@localhost:55432/openbot bun run test:ci
```

`typecheck` covers **`tests` as well as `src`**, in every workspace and at the
root. It did not until 2026-09-03, and sixty-four errors were waiting: fixtures
missing required fields, stubs cast to `never` so their callbacks took `any`,
assertions on fields that two migrations ago stopped existing — `undefined`
matching `undefined`, green for months. Never narrow an `include` back to `src`.

`test:ci` reads `DATABASE_URL` for its server and credentials and then never
hands it to a test — see below. It also refuses to pass below a floor of tests,
one floor per workspace, so a suite that quietly lost an area fails instead of
going green. Raise a floor when that workspace grows; lower it only with a
reason.

## Running it locally

```bash
docker compose up -d postgres
COMPUTER_TOKEN=laf-local-dev docker compose up -d agent-computer
(cd agent-bot && PORT=4200 bun --env-file=../.env src/index.ts)
(cd server && AGENT_COMPUTER_URL=http://localhost:4100 COMPUTER_TOKEN=laf-local-dev bun --env-file=../.env src/index.ts)
(cd app && bun run dev)
```

`agent-computer` runs from an **image**, not from source: editing it and
restarting the container changes nothing. `docker compose build agent-computer`
first. And it refuses to start without `COMPUTER_TOKEN`, which compose does not
supply on its own.

Deployments never build: CI publishes all four images to GHCR (`images.yml`)
and compose pulls them by `IMAGE_TAG` (stable/edge/vX.Y.Z). Local `compose up`
may pull too — build first when you need your local edits in the container.

## Rules

### Verify by using it, not by reading it

Everything in this session that was actually broken typechecked and passed
tests. The step counter that never moved, the recording that vanished on
reload, the panel that drew five times, the effort setting that reached
nothing — none of those are visible from a green gate. Open the page. Press the
button. Read what the other service actually received.

And when reporting, say what you measured. "It answered normally" is not
evidence that a setting was applied; it is what happens when the setting goes
nowhere.

### Every Bot a person creates is remote

Only Bots a package shipped are `built_in`. Everything anybody makes is
`remote_ag_ui`, answered by `agent-bot`. **Wiring a per-Bot behaviour into the
built-in configuration reaches nothing anybody will ever use.** Per-run settings
travel as AG-UI `forwardedProps` through the middleware in `copilot.ts`, which
is the one seam every path goes through — chat, rooms and routines alike.

### The computer reads the Bot from a header

`agent-computer` takes the Bot from `x-openbot-bot-id` and **refuses without
it** — 400 `laf:bot_header_missing` on every route but `/health` and
`/computers`. It used to fall back to `"shared"` while the server fell back to
`"default"`, which is the blank page belonging to nobody, twice, answering as
though it had worked. The live-screen socket is the one exception and only
because a websocket upgrade carries no custom header: it accepts `?bot=`, and
the header still wins.

### Korean is not optional

Every user-facing string goes through `t()` from `@/lib/i18n`, English as the
key, with the Korean entry added in `i18n-ko.ts` in the same change.
`app/tests/i18n-coverage.test.ts` enforces it — but **only for literal
`t("…")`**. `t(someVariable)` is invisible to it, so a table of strings read
that way needs its own test walking the table (see `agent-presets.test.ts`).

Server prose does not cross to the surface. The server sends facts; the surface
owns the words.

### A boundary must never lie

Anything that lets an action past without a person seeing it —
a standing allowance, an auto-review instruction — is governed by one switch
(`settleWithoutAsking`), records who decided and why, and never softens a
`deny`. A control that saves and does nothing is worse than no control: if a
deployment's model cannot do the thing, do not draw the control.

Never let a Bot write the rule that decides whether it gets asked about.
`update_profile` reaches the profile and `manage_routine` the routines; neither
may reach `autoReview`.

### Never record what somebody typed

Every keystroke in a Bot's browser passes through the demonstration recorder,
including passwords. Record that typing happened and where, never a value —
the same rule as the audit fingerprint. Test it by serialising the whole record
and asserting the password is nowhere in it.

### Model calls

Swapping the model is a ritual, not a debate: `bun run eval:model` drives the
real agent-bot stack against a candidate and verdicts it (docs/laf/eval-pack.md).

`askModel` in `server/src/computer/model-call.ts` is the one place. Two traps
measured here:

- **A token ceiling can silently empty the answer.** A reasoning model spends
  the budget thinking and returns an empty message. The timeout is the bound
  that matters.
- **Failures are not all the same failure.** A provider refusing (429) wants
  waiting; an unusable reply wants pressing again. Saying "try again" in front
  of an instant refusal is how a working feature looks broken.

### The tests have a database of their own

`test:ci` runs them in `<name>_test` on the server `DATABASE_URL` names,
creating and migrating it if it is absent. The database you develop against is
never written to — two files delete rows by identity rather than by what they
made (the boundary policy row, every Google Drive connector instance), and
against a live database that is somebody's afternoon. Run the gate twice at once
by giving each worktree `LAF_TEST_DB_SUFFIX`; they land in different databases.

The old rule still holds inside that database, because the tests still share it
with each other: clean up your rows, scope every cleanup to what the test
created — an unscoped `delete(table)` once erased every routine in the database
— and never assume a row exists because the app put it there. A suite that
passes only on the machine it was written on is the failure mode
(`room-transcript.integration.test.ts` had exactly that), and it is now the
normal case, since the test database starts empty.

## Conventions

- `const` arrow components; `handle`-prefixed handlers; verb-prefixed booleans.
- PascalCase component files; kebab-case everything else.
- Tailwind classes only. No inline styles.
- Comments explain **why**, and are worth most where they record what went
  wrong. A comment saying what the line does is noise.
- Conventional Commits. Every commit ends with:
  `Co-authored-by: LAF Agent <274876363+laf-agent@users.noreply.github.com>`

## Things that are not in this repository

The business plans, the milestone execution notes and the working log live in
`~/laf/` — **outside any repository**, because this one is public. Never commit
them and never move them in "temporarily". `~/laf/activity.md` is the running
log; prepend an entry after finishing a piece of work, newest first, with a
Dubai-time heading, what changed, and the files touched.
