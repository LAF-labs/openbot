#!/usr/bin/env bash
#
# Upgrade one deployment: dump, pull, up, and then ASK whether it worked.
#
# The two commands in deploying.md — `docker compose pull && docker compose up -d` — are the
# upgrade, and everything dangerous about it is what they do not do. They take no dump, so a
# migration that goes wrong has nothing to go back to. They do not wait, so the shell prompt returns
# while the API is still deciding whether it can start. And they never check, so an upgrade that
# left the deployment answering 503 looks exactly like one that worked.
#
# This is those two commands with a dump in front and the honest /health behind, plus the rollback
# printed at the moment somebody needs it rather than in a document they will not be reading at 2am.
#
# The order is the safety: the dump is taken while everything is still running, the pull happens
# before anything is replaced — so a pull that fails leaves the deployment running exactly what it
# ran — and only `up -d` moves anything. Nothing here stops a container by hand, and nothing here
# writes `.env`: compose reads it, this script reads one line of it, and `tests/upgrade-script.test.ts`
# compares the bytes before and after.
#
# It does not add `pull_policy: always` to compose, deliberately: a pull is a decision, and a
# reboot or an unrelated `up -d` must never be able to move a deployment to a new image on its own.
#
#   scripts/upgrade.sh              # upgrade to whatever IMAGE_TAG in .env names
#   IMAGE_TAG=v0.3.2 scripts/upgrade.sh
#
# Environment:
#   BACKUP_DIR       where the dump goes (default /var/backups/laf)
#   HEALTH_TIMEOUT   seconds to wait for /health to answer ok (default 180)

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

backup_dir="${BACKUP_DIR:-/var/backups/laf}"
health_timeout="${HEALTH_TIMEOUT:-180}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump="$backup_dir/laf-$stamp.sql.gz"
inventory="$backup_dir/laf-$stamp.images.txt"

say() { printf '\n== %s\n' "$*"; }

if [ ! -f .env ]; then
  echo "No .env here. This script upgrades a deployment, and a deployment is a directory with a .env in it." >&2
  exit 1
fi

# The channel this deployment is on, as .env names it. Read for the rollback message only: compose
# reads .env itself, and this script never passes it on.
previous_tag="$(sed -n 's/^IMAGE_TAG=//p' .env | tail -1)"
previous_tag="${previous_tag:-stable}"

# The way back, printed by both failures below. Two steps, and the second is the SAFE restore:
# `scripts/restore.sh` restores beside the live database, prints every table's row count on both
# sides, and swaps only on --replace after the name is typed. This used to print
# `zcat $dump | psql openbot` — the form restore.sh's own header calls dangerous: into the live
# database, without --clean, so every CREATE fails "already exists", psql carries on without
# ON_ERROR_STOP, and the COPYs half-apply on duplicate keys. Neither rolled back nor left alone,
# on the one screen somebody is reading at 2am. Measured 2026-09-10 (audit A5 §3).
print_rollback() {
  cat >&2 <<ROLLBACK

To go back:

  IMAGE_TAG=<previous version> docker compose pull && docker compose up -d

ROLLBACK
  if printf '%s' "$previous_tag" | grep -Eq '^v[0-9]'; then
    echo "  This deployment was on IMAGE_TAG=$previous_tag before this run, so that is the value." >&2
  else
    echo "  This deployment follows IMAGE_TAG=$previous_tag, which is a channel that has already moved." >&2
    echo "  What was running before the pull, by digest, is in $inventory — read the version out of it." >&2
  fi
  cat >&2 <<CAVEAT

  THE SCHEMA MAY HAVE MOVED FORWARD. The migration container runs before the API starts, so an
  older image can meet a newer database and fail in a way that reads as an unrelated bug. If the
  rollback does not come up clean, restore the dump taken at the top of this run — beside the live
  database first, then the swap:

    scripts/restore.sh $dump --replace

  It prints every table's row count, live against restored, and waits for you to type the database
  name. Read the counts before you type: a day's difference on the trail is the dump's age; a
  difference on users, agents or credentials is a question.

CAVEAT
}

say "Dumping the database to $dump"
mkdir -p "$backup_dir"
# -T because there is no terminal here, and without it `exec` allocates one and gzip receives a
# stream with carriage returns in it — a dump that restores as a syntax error, months later.
docker compose exec -T postgres pg_dump -U openbot openbot | gzip >"$dump"
# A dump of nothing succeeds quietly: a container that is not running makes `exec` fail, but an
# empty result from a database that answered does not. And it is not an empty FILE — gzip wraps
# nothing in twenty bytes of header and trailer, so the `-s` test this used to be was green on it
# (measured 2026-09-10, by the test that first exercised this line). The proof is the one
# restore.sh asks of a dump before it will touch it: the first lines say what pg_dump says.
if ! gzip -dc "$dump" 2>/dev/null | head -c 4096 | grep -q 'PostgreSQL database dump'; then
  echo "The dump is empty. Refusing to upgrade over a backup that would restore nothing." >&2
  exit 1
fi
ls -l "$dump"

# Exactly what is running right now, by digest. The tag a deployment follows is usually `stable`,
# which MOVES — so "the previous version" is not recoverable from .env after the pull, and this file
# is the only record of what to go back to.
docker compose images >"$inventory" 2>/dev/null || true

say "Pulling images"
# Before anything is replaced, so that a registry that refuses, a token that expired or a network
# that is down leaves the deployment running what it ran. Said out loud, because a failure here at
# 2am reads like the upgrade broke something, and it has not touched anything yet.
if ! docker compose pull; then
  cat >&2 <<PULLFAILED

== The pull failed. Nothing was stopped or replaced: the deployment is running exactly what it ran
   before this command. The dump at $dump is the only thing this run made. Fix the registry
   login or the network and run this again.
PULLFAILED
  exit 1
fi

say "Starting"
# `up -d` exits non-zero when a service it was asked for could not be started, and the one that
# fails here is the migration: the API waits for it to complete successfully, and compose does not
# start a service whose dependency failed. The front door does not wait for either (see the `web`
# service), so a failed migration leaves 80 and 443 answering — the app, and 503 `down` at
# /health — with no API behind them. Named here, with the migration's own log, rather than left to
# be inferred from a health wait that could never succeed.
up_ok=true
docker compose up -d || up_ok=false
migrate_exit="$(docker compose ps -a --format '{{.ExitCode}}' migrate 2>/dev/null | head -1 || true)"
migrate_exit="${migrate_exit:-0}"
if [ "$up_ok" != true ] || [ "$migrate_exit" != 0 ]; then
  if [ "$migrate_exit" != 0 ]; then
    say "THE MIGRATION FAILED (migrate exited $migrate_exit). The API was not started; the front door is up and answers 503 (down) for it."
    echo "   The schema is where it was: drizzle applies the missing migrations in one transaction, so a failure leaves none of them applied." >&2
    echo "   What it said:" >&2
    docker compose logs migrate --tail=30 >&2 || true
  else
    say "docker compose up did not start everything."
    docker compose ps -a >&2 || true
  fi
  print_rollback
  exit 1
fi

say "Waiting for /health (up to ${health_timeout}s)"
# Asked from inside the API container, which is where the answer is: `server` is deliberately
# unpublished, so there is no port on this host to curl. This is the same request compose's own
# healthcheck makes — the honest one, which probes the database, agent-bot and the computer and
# answers 503 when any of them is down. At least one probe, and no sleep after the last one.
deadline=$(( $(date +%s) + health_timeout ))
healthy=false
while :; do
  if docker compose exec -T server bun -e \
    "const r = await fetch('http://localhost:3001/health'); console.log(await r.text()); process.exit(r.ok ? 0 : 1)"; then
    healthy=true
    break
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 5
done

if [ "$healthy" = true ]; then
  say "Healthy."
  docker compose ps
  exit 0
fi

cat >&2 <<NOTHEALTHY

== NOT HEALTHY after ${health_timeout}s. The deployment is up and answering 503, or not answering.

What it says, and which dependency is down:

  docker compose exec -T server bun -e "const r = await fetch('http://localhost:3001/health'); console.log(r.status, await r.text())"
  docker compose ps
  docker compose logs server --tail=50
NOTHEALTHY

print_rollback
exit 1
