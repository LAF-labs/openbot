# Operating a deployment — the log

Written 2026-09-06 (launch plan 3-D). For: whoever reads `docker compose logs` over SSH on a
customer's VM. Decisions this rests on: `deployment-model.md` (one process per service, one VM
per person), `deploying.md` §"Logs" (the `json-file` cap), `data-lifecycle.md` (what the trail
keeps; the log keeps less).

## 1. One line, one fact

Every line the three services write is one JSON object:

```
{"level":"info","at":"2026-09-06T01:33:16.249Z","svc":"server","event":"boot","version":"edge","model":"z-ai/glm-5.3-flash","reviewModel":"…","supportsEffort":true,"tools":18,"port":3001,"computer":"one shared computer","fleetWebhook":true,"stallTimeoutMs":60000,"retentionDays":365}
```

The first four keys are always there and always in this order:

| key     | what                                                                                   |
| ------- | -------------------------------------------------------------------------------------- |
| `level` | `info`, `warn` or `error`. `info` goes to stdout, the other two to stderr.             |
| `at`    | ISO-8601 UTC. Compose adds its own timestamp too; this one is the process's.           |
| `svc`   | `server`, `agent-bot` or `agent-computer` — the compose service name, so the two agree. |
| `event` | A snake_case word for what happened. Grep by this, never by a sentence.                |

Everything after is the event's facts. There is no free-text `message` field on purpose: a
sentence is what gets paraphrased, and a paraphrase is what a grep stops matching. Where a line
carries an explanation for the reader it is under `note` or `hint`, and nothing parses it.

The shape is `shared/log.ts`; each service holds one instance (`server/src/log.ts`,
`agent-computer/src/log.ts`, and `agent-bot/src/index.ts` makes its own). A test walks the three
source trees and fails on any `console.*` call outside the logger (`tests/log-discipline.test.ts`).

## 2. Reading it

```bash
docker compose logs -f --since 1h server agent-bot          # the two that answer a person
docker compose logs server | grep '"event":"boot"'          # which build and model is up
docker compose logs agent-bot | grep '"event":"run_failed"' # why turns are failing
docker compose logs --no-log-prefix server | jq -c 'select(.level=="error")'
```

`--no-log-prefix` is what makes the lines valid JSON for `jq`; with the prefix, compose puts the
service name in front of each line.

The lines worth knowing by name:

| `event`                        | `svc`            | when                                                                                                    |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `boot`                         | all three        | The process is listening. `version` is the compose channel it was pulled by (`IMAGE_TAG`: stable, edge, vX.Y.Z; `source` when run from a checkout), `model` the one every Bot answers on, `tools` the core catalogue's size (computer + self + skill tools; connected-service tools are per person and per run). |
| `shutdown`                     | all three        | The process was told to stop, and `reason` says by what (`SIGTERM` from `docker stop`). A log whose last line is not this one is a process the kernel killed or that crashed — see the next row. |
| `crashed`                      | all three        | An uncaught exception ended the process: `reason` is the failure's kind, `where` its first stack frame. A server started against an unmigrated database says `database error (42P01)` here rather than the statement. |
| `boot_refused`                 | agent-bot, computer | A required setting is missing (`bot_model_unset`, `computer_token_unset`). The process exits 1 and compose restarts it; fix `.env`. |
| `run_finished` / `run_failed`  | agent-bot        | One turn of one Bot. `bot` and `run` identify it; `tools` is what the run was handed, `exposed` what the model was shown, `ms` how long. `run_failed` carries `code` (the `laf:` code the person's screen translated) and `reason` (below). |
| `reply_empty`, `reply_empty_retrying`, `reply_truncated` | agent-bot | The model came back with nothing (retried once at lower effort) or stopped mid-answer (`finish_reason: length`). |
| `runs_reconciled`              | server           | At boot: `count` runs were still `running` when the last process died and were marked `unknown`. |
| `interrupted_runs_reported`    | server           | At boot, once the outbox exists: `count` of those runs whose person was told (`run.failed`, `laf:turn_interrupted`). `interrupted_routine_not_marked` / `interrupted_conversation_not_read` name a run that could not be marked or placed; it is still told about. |
| `agent_stream_stalled`         | server           | A Bot's stream produced nothing for `AGENT_STALL_TIMEOUT_MS`; the turn was ended for the person. |
| `model_call_refused`, `auto_review_probe_failed` | server | The server's own model calls (the auto-review judge, the demonstration write-up) were refused or unusable. |
| `dev_no_auth`, `encryption_key_is_example`, `fleet_webhook_unconfigured` | server | Boot warnings about settings that are fine on a laptop and wrong on a VM. |
| `unhandled_rejection`          | server           | A promise nobody awaited rejected; the server kept running (a remote Bot's socket resetting must not take everyone down). |

A provider failure is said as one of a closed set of words, whichever road it came by (the OpenAI
client in `agent-bot`, or the hand-written call in `server/src/computer/model-call.ts`):

| `reason`                        | what to do                                                                 |
| ------------------------------- | -------------------------------------------------------------------------- |
| `provider_rate_limited`         | 429. Wait. Pressing again now is what makes a working feature look broken. |
| `provider_refused`              | 401/403. The key, not the request: check `OPENAI_API_KEY`.                 |
| `provider_unavailable (503)`    | 5xx. Theirs. Wait, then check the provider's status page.                  |
| `provider_rejected_request (400)` | 4xx. Ours: a setting the model does not take (`BOT_MODEL_EFFORT` on a model that does not reason), or a model name the endpoint does not serve. |
| `provider_unreachable`, `provider_timed_out` | No connection, or none in time. `OPENAI_BASE_URL`, DNS, egress. |
| `reply_unusable`                | It answered and the answer could not be read. Pressing again may well work. |
| `request_aborted`               | This deployment gave up on the request — `agent-bot`'s 120 s bound, or a turn cancelled. |

The words are `describeFailure` / `providerStatusFact` in `shared/failure-text.ts`, and the same
function is what the audit trail and a run's `error` column store, so the log and the trail agree.

## 3. What is never in it

The log is on a disk that is rotated, shipped to a laptop by `laf collect`, and pasted into
tickets. It carries facts about what happened and never the material it happened to:

- **No model key, no token, no cookie, no `Authorization` header.** A field named like a secret
  (`token`, `cookie`, `authorization`, `apiKey`, `password`…) is replaced with `[redacted]` when
  its value is a string; a string that looks like one — `sk-…`, `Bearer …`, a JWT, a URL with a
  password in it — is cut where the secret starts.
- **Nothing a person or a Bot typed.** Not the message, not the answer, not the text a Bot typed
  into a page. `run_finished` says a turn happened, for which Bot, how long, how many tools —
  counts, ids and durations only. The same rule as the audit fingerprint and the demonstration
  recorder (`CLAUDE.md`, "Never record what somebody typed").
- **No SQL.** A Drizzle error's message is the statement and every bound parameter — for a failed
  message append, the whole conversation. Every error goes through `describeFailure`, which turns a
  query error into its PostgreSQL code (`database error (23505)`).
- **No provider prose.** The OpenAI client's error message is the status followed by the
  provider's body, which names the vendor, the model's real catalogue entry and its URLs. The log
  says which kind of failure it was (§2) and nothing the provider wrote.
- **No stack traces as the message.** An error handed to the logger is described, not printed;
  `crashed` keeps the first frame as `where`, which is a file and a line.

This is enforced three ways, and each catches what the others cannot:

1. `shared/log.ts` scrubs every field of every line (`tests/log.test.ts`).
2. `tests/log-discipline.test.ts` refuses a `console.*` call anywhere in the three service
   sources, so a line cannot bypass the scrubbing. The files still on `console` are listed there
   with a ceiling each — they belong to workstreams landing at the same time, and their
   injectable `log` is already pointed at the process log from `server/src/index.ts`.
3. `server/tests/log-hygiene.integration.test.ts` starts the real server and the real Bot
   service as subprocesses against a fake provider, drives one turn through the API with a
   canary key in the environment (`sk-canary-…`), a canary message naming a password, and a
   second turn the provider answers with a 429 whose body names a vendor — then greps everything
   both processes wrote. None of the three may appear; every line must parse; `boot`, `run_failed`
   (`provider_rate_limited`) and `shutdown` (`SIGTERM`) must. `LOG_HYGIENE_DUMP=1` prints the
   captured lines.

The manual version of the same check, on a VM, after telling a Bot "내 계좌 비밀번호는 1234야":

```bash
docker compose logs server agent-bot | grep -c 1234      # 0
docker compose logs server agent-bot | grep -ci bearer   # 0
docker compose logs server agent-bot | grep -ci 'select ' # 0
```

## 4. What was there before (2026-09-06)

Measured on the tree before this change, so the next reader knows what the tests are guarding
against rather than taking them on faith:

- `agent-bot` logged a failed run as `console.error("… run failed:", error)` with the OpenAI
  client's error object. Bun prints an error object whole: the message (`429 ` + the provider's
  body, naming the vendor, the catalogue name and URLs), the response `headers`, the `error` body
  again, and the stack. The comment beside it said the full error "goes to this service's own
  log, where an operator reads it and no customer does" — true, and the log is what gets pasted.
- `server/src/rooms/service.ts` logged a failed member turn the same way, and the errors that
  reach it include Drizzle's — statement and bound parameters, which for a transcript append is
  the room's message array.
- A server started against an unmigrated database died with Bun's own report of the uncaught
  exception: `update "laf_thread_runs" set "status" = $1 …` with its values, on stderr.
- Seven shapes of line across three services: bare sentences (`agent-bot listening on http://…`),
  `[tag] sentence` prefixes, hand-rolled `JSON.stringify({type: …})` objects with no level and no
  time, and `console.warn(string)` defaults inside modules that take an injectable `log` nobody
  injected.
- Nothing said which build was running. `IMAGE_TAG` named the image compose pulled and reached no
  process; it is passed into all three now, and `boot` says it.

## 5. What is deliberately not here

- **No log shipping and no log search.** One VM per person, one log per service, capped by
  `json-file` at 10 MB × 5 (`deploying.md`). `laf collect` copies them; the search is `grep`.
- **No request log.** A line per HTTP request is a line per keystroke on the live screen and per
  poll of the roster, and the facts an operator needs — which turn failed, which run stalled — are
  on the turn, not the request. The audit trail is the per-action record, and it is queryable.
- **No log level setting.** Three levels, all written. A deployment that is too noisy has a bug,
  not a verbosity problem.
