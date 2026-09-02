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

Run these before opening a pull request:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
```

Integration tests expect a PostgreSQL database with pgvector. Use `start.sh` or point `DATABASE_URL` at a compatible database.

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
suite cannot reach: server to computer, the gateway deciding before the browser acts,
and the audit row landing. Point it elsewhere with `LAF_API_URL`. Without a deployment it is
skipped by `bun run test` and says what to start when asked for by name.

## Contribution checklist

- Keep changes focused.
- Keep credentials, service-account JSON, customer data, and transcripts out of source control.
- Put sensitive behavior on the server, not only in the browser.
- Update [configuration](configuration.md), [architecture](architecture.md), or the root [README](../README.md) when behavior changes.
- Run the quality checks above and include the results in the pull request.
