# Development

## Setup

Install Docker, [Bun](https://bun.sh) 1.3+, `lsof`, `python3`, and `curl`.

```sh
cp .env.example .env
bun install
```

Add `OPENAI_API_KEY` (or point `OPENAI_BASE_URL` at any endpoint speaking the same API). Threads
and memory are stored in PostgreSQL; no external thread service is involved.

Start the stack:

```sh
bash scripts/start.sh
```

## Running services

Use `bash scripts/start.sh` for the full local stack. It starts Docker services, applies migrations, starts the API server and app, and verifies health routes.

Use `bun run dev` only when you want the app and API server without starting the Docker Bots and computers.

| Service           | Port                       |
| ----------------- | -------------------------- |
| `app`             | 3010                       |
| `server`          | 3001                       |
| `agent-computer`  | 4100                       |
| `agent-bot`       | 4200                       |
| PostgreSQL        | 5432                       |

`start.sh` leaves existing matching services alone and reports when a port is held by another process.

### Starting one service by hand

`agent-bot` needs its port passed in. It reads `PORT` from the shared `../.env`, where the value is
`3001` — the API server's port — so without the override it exits with `EADDRINUSE` against a server
that is already running, and the error names the wrong process:

```sh
cd agent-bot && PORT=4200 bun --env-file=../.env src/index.ts
```

### Do not `pkill -f "bun --env-file=../.env src/index.ts"`

The API server and `agent-bot` have **identical command lines** — same runner, same env file, same
entry path, different directories. That pattern matches both, so restarting the server silently
takes the runtime with it, and nothing says so: the server comes back, the app loads, the roster
renders, and the next turn fails with

```
Agent execution failed: error: Unable to connect. Is the computer able to access the url?
```

which reads as a network problem and is a process that is no longer there.

Kill the **listener**, and only the listener:

```sh
lsof -ti tcp:3001 -sTCP:LISTEN | xargs kill
```

`-sTCP:LISTEN` is not optional either. Without it, `lsof -ti tcp:3001` lists every process holding
*any* socket on that port — including clients **connected** to it. Vite proxies `/api` to 3001, so
it is one of them, and the "safe" kill-by-port takes the app dev server down with the API server.
Same failure shape as the `pkill` above: the thing you aimed at restarts, something else silently
does not.

Check what is actually listening:

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3001|3010|4200|55432)'
```

## Migrations

After changing the Drizzle schema:

```sh
bun run --filter server db:generate
bun run --filter server db:migrate
```

Review generated migration files before sharing them. `start.sh` applies existing migrations when it starts the stack.

## Quality checks

The gate. A change is not done until all four pass:

```sh
bun run typecheck
bunx biome lint .
bun run format:check
DATABASE_URL=postgres://openbot:openbot@localhost:55432/openbot bun run test:ci
```

`bun run build` as well, for anything that touches how the app is built.

Integration tests expect a PostgreSQL 17 database. Use `start.sh` or point `DATABASE_URL` at a compatible database.

`bun run test:ci` is the one that keeps them off your own data. It reads `DATABASE_URL` for its
server and credentials only, then runs everything in `<name>_test` on that server — created and
migrated on first use:

```sh
DATABASE_URL=postgres://openbot:openbot@localhost:55432/openbot bun run test:ci
```

Two runs at once need two databases, or they interfere with each other exactly the way they used
to interfere with the development database. Give each one a name:

```sh
LAF_TEST_DB_SUFFIX=mybranch DATABASE_URL=... bun run test:ci   # runs in openbot_test_mybranch
```

They also need connections. One run peaks at 67 of PostgreSQL's default 100 — every test file that
touches the database holds its own small pool for the whole run — so a second one fails on `sorry,
too many clients already`, which reads as broken tests and is a full connection table. Raise the
limit before running two:

```sh
POSTGRES_MAX_CONNECTIONS=300 docker compose up -d postgres
```

It takes effect on container recreation, not on restart, and the default stays 100 so a deployment
is unaffected.

Bare `bun test` still writes to whatever `DATABASE_URL` names, so it is for one file at a time
against a database you are willing to lose.

Test rows still get cleaned up, because the tests share the test database with each other. Every
test's cleanup is scoped to the rows that test created — an unscoped `delete(table)` in an
`afterEach` once erased every routine a person had made, each time the suite ran. Keep it that way:
a new integration test deletes by its own actor, prefix or Bot id, never the table.

`test:ci` also verifies the expected test count, one floor per workspace (`server`, `app`,
`agent-computer`, and `root` for `tests/` plus `agent-bot/`). A file that throws while being
imported reports no failure at all — its tests simply never register — so the count is asserted
alongside the result. Lower a floor in `scripts/test-ci.ts` when tests are deliberately removed,
and say why.

`bun run test:smoke` is separate and needs a deployment that is up:

```sh
bash scripts/start.sh
bun run test:smoke
```

It drives one journey over HTTP against the running stack, so it covers the joins the rest of the
suite cannot reach. In order:

1. The deployment answers for itself, has Bots registered with the runtime, and mints thread ids.
2. It makes a Bot of its own, serves a Korean shop page from the test process with `Bun.serve`, and
   sends the Bot's browser to it. The page title carries a nonce minted for the run, so "the
   computer really loaded it" is checked rather than assumed.
3. It presses 결제하기 on that page. **Nothing writes a policy first**: what stops the click is the
   `ask` list a fresh deployment ships, so this is a test of the boundary a person actually gets.
   The reply is 409 with an approval id, the question is waiting on `/api/approvals/:bot`, somebody
   answers yes there, the same click is presented with the answer, and the page changes.
4. It asks again and says no, and the next attempt is refused outright with `laf:declined_recently`
   rather than asked again.
5. With a model key, it creates a routine, runs it now, and checks the Bot's answer carries the
   nonce — which it can only have got by opening the page through its own computer.
6. It deletes the Bot it made.

What it needs is a whole deployment — Docker, a model key, and a computer that answers — plus a way
in: it sends no credentials and reads `/api/admin/audit-events`, so the deployment has to be
admitting it, which locally means `LAF_DEV_NO_AUTH=true`.

| Variable                  | Default                 | Meaning                                                                                    |
| ------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `LAF_SMOKE`               | unset                   | `1` runs it. `bun run test:smoke` sets it; without it every test skips, so `bun run test` stays honest on a machine with nothing running. |
| `LAF_API_URL`             | `http://localhost:3001` | The deployment to drive.                                                                   |
| `LAF_SMOKE_BOT`           | unset                   | An existing Bot to act as. Unset, the run **makes its own** in `beforeAll` and deletes it in `afterAll` — an account has five seats and a smoke run per deploy would eat them all. |
| `LAF_SMOKE_MODEL`         | unset                   | `0` skips the routine turn, for a deployment with no model key. Everything else still runs. |
| `LAF_SMOKE_FIXTURE_HOST`  | `host.docker.internal`  | How the Bot's browser reaches the machine serving the fixture page. Docker Desktop provides that name; on Linux there is none, so pass the gateway of the computer's own network (`docker inspect <container> --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'`) and start the server with `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true`, because a gateway address is private and the navigation guard refuses those by default — as it should on anything hosted. |

It used to drive `risk-analyst`, a Bot the tenant package shipped, and `example.com` for a page.
The package ships no Bot — a Bot starts with nothing set and belongs to the person who made it —
and somebody else's website gave the journey nothing worth clicking. Its own Bot and its own page
are what keep the test about the joins it is checking.

### Nightly

`.github/workflows/smoke.yml` runs the same journey against `docker compose`, at 02:40 UTC and on
`workflow_dispatch`. It builds `agent-computer` rather than pulling `:stable`, so a nightly reports
on the branch it ran from rather than on the last release, and it runs the API on the runner the
way `scripts/start.sh` does so the fixture page is reachable from both sides.

**It needs an `OPENAI_API_KEY` secret and skips cleanly without one**, saying so in a notice rather
than failing: a red cross a fork cannot act on teaches people to ignore the job. `OPENAI_BASE_URL`
and `BOT_MODEL` are read from repository variables when set, so the nightly can be pointed at the
same provider a deployment uses.

## Contribution checklist

- Keep changes focused.
- Keep credentials, service-account JSON, customer data, and transcripts out of source control.
- Put sensitive behavior on the server, not only in the browser.
- Update [configuration](configuration.md), [architecture](architecture.md), or the root [README](../README.md) when behavior changes.
- Run the quality checks above and include the results in the pull request.
