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
#   scripts/upgrade.sh      # upgrade to whatever IMAGE_TAG in .env names (`stable` if it names none)
#
# To move a deployment to another version, change the IMAGE_TAG line in .env first, then run this.
# An IMAGE_TAG in the environment that disagrees with .env is refused before anything is touched —
# see "ONE PLACE DECIDES" below for why `IMAGE_TAG=v0.3.2 scripts/upgrade.sh` stopped being the way.
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

# The version this deployment is set to, read the way compose reads .env — measured against compose
# 5.1.1: the last IMAGE_TAG line, `export ` in front of it or not, spaces around the `=` and the
# value, a Windows line ending, an inline comment (a `#` after a space) and one pair of surrounding
# quotes all taken off; no line, or an empty value, is compose's own default, `stable`
# (`${IMAGE_TAG:-stable}` in docker-compose.yml). Read, never written.
env_tag="$(
  sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}IMAGE_TAG[[:space:]]*=//p' .env |
    tail -n 1 |
    tr -d '\r' |
    sed -e 's/[[:space:]]\{1,\}#.*$//' \
      -e 's/^[[:space:]]*//' \
      -e 's/[[:space:]]*$//' \
      -e 's/^"\(.*\)"$/\1/' \
      -e "s/^'\(.*\)'\$/\1/"
)"
env_tag="${env_tag:-stable}"

# ONE PLACE DECIDES A DEPLOYMENT'S VERSION, AND IT IS .env.
#
# `IMAGE_TAG=v0.3.2 scripts/upgrade.sh` was the documented way to move to a version, and it moved the
# deployment for one run: compose prefers the environment to .env, so the pull and the `up -d` below
# took v0.3.2 while .env went on naming the old tag — and the next `docker compose up -d`, anybody's,
# read .env and put the old images back over a schema this run had migrated forward (audit
# 2026-09-16, R6 F6). So a set IMAGE_TAG is resolved the way compose resolves it — set, even to
# nothing, it beats .env, and empty is `stable` (measured) — and one that disagrees with .env is
# refused before anything is dialled. One that agrees changes nothing, and is dropped, so every
# compose call below reads .env.
if [ -n "${IMAGE_TAG+set}" ]; then
  asked_tag="${IMAGE_TAG:-stable}"
  if [ "$asked_tag" != "$env_tag" ]; then
    cat >&2 <<REFUSED
IMAGE_TAG is $asked_tag in this shell and $env_tag in .env. Refusing, before anything is touched.

Compose takes the shell's value over .env's, so this run would pull and start $asked_tag while .env
went on saying $env_tag — and the next docker compose up -d, anybody's, would read .env and put
$env_tag back over a database this run's migrations may already have moved forward.

To move this deployment to $asked_tag, make it the deployment's version, then run this again:

  1. In $root/.env, set the IMAGE_TAG line to IMAGE_TAG=$asked_tag (add the line if there is none).
  2. unset IMAGE_TAG
  3. scripts/upgrade.sh

To upgrade to what .env names instead, run steps 2 and 3 alone.
REFUSED
    exit 1
  fi
  unset IMAGE_TAG
fi

# The way back, printed by both failures below. Two steps, and the second is the SAFE restore:
# `scripts/restore.sh` restores beside the live database, prints every table's row count on both
# sides, and swaps only on --replace after the name is typed. This used to print
# `zcat $dump | psql openbot` — the form restore.sh's own header calls dangerous: into the live
# database, without --clean, so every CREATE fails "already exists", psql carries on without
# ON_ERROR_STOP, and the COPYs half-apply on duplicate keys. Neither rolled back nor left alone,
# on the one screen somebody is reading at 2am. Measured 2026-09-10 (audit A5 §3).
#
# THE FIRST STEP DID NOT ROLL BACK EITHER, until 2026-09-16. It was
# `IMAGE_TAG=<previous version> docker compose pull && docker compose up -d`, and a variable written
# in front of a command reaches that command only: the pull took the old version, the `up -d` read
# .env and started the images that had just failed (audit 2026-09-16, R6 F6; measured with compose
# 5.1.1, and replayed by the test through a fake that resolves the tag the same way). It also asked
# for a version nothing on the screen named. Now the version is named when the record says it, and
# the step both pins it in .env — which every later `up -d` reads — and exports it for the two
# commands that follow.
print_rollback() {
  local tag="${rollback_tag:-vX.Y.Z}"
  {
    printf '\nTo go back to what ran before this run.\n\n'
    printf '  What ran, as %s recorded it before the pull:\n' "$inventory"
    printf '%s\n' "${running:-(no container could be read)}" | sed 's/^/    /'
    printf '  VERSION in %s, when this run began:\n' "$root"
    printf '%s\n' "${version_file:-(there was no VERSION file)}" | sed 's/^/    /'
    if [ -n "$rollback_tag" ]; then
      printf '\n  Those images are %s, so that is the version below.\n' "$rollback_tag"
    else
      cat <<UNNAMED

  None of that names a version, so the lines below say vX.Y.Z. Put there the release whose images
  carry the revision above — for a deployment on stable, the release stable named before this run.
  As printed they fail safely: no image is tagged vX.Y.Z, so the pull refuses and nothing is
  replaced. An edge build has no tag of its own, and once edge has moved it cannot be pulled again.
UNNAMED
    fi
    cat <<ROLLBACK

  The rollback pins the version in .env and exports it, then pulls and starts it:

    1. Pin it. In $root/.env, set the IMAGE_TAG line to
         IMAGE_TAG=$tag
       (add the line if there is none).
    2. Pull it and start it, from $root:
         export IMAGE_TAG=$tag; docker compose pull && docker compose up -d

  Step 1 is what keeps it: every later docker compose up -d reads .env, and while .env says
  $env_tag the next one puts back the images that just failed. Step 2 exports the value so the
  pull and the up -d both take it, whatever this shell had exported before.
ROLLBACK
  } >&2
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

# WHAT IS RUNNING, AND WHICH BUILD IT IS, before the pull moves what the tags point at.
#
# The tag a deployment follows is usually `stable`, which MOVES, so after the pull neither .env nor
# `docker compose images` can say what ran before — and that table, which was all this file held,
# is a tag and a short image id, neither of them a version (audit 2026-09-16, R6 F6). So the file
# keeps what a version is read from:
#  - VERSION as this run found it: the bundle's revision and the channel it was built for. With the
#    bundle refreshed first, as deploying.md says, that is already the build this run moves TO; left
#    alone, it is the one the running images came with.
#  - for every container, the image reference it was created from, that image's
#    `org.opencontainers.image.revision` (the commit images.yml stamps on every build), and its id.
#    Asked of the containers rather than of the tags, because a pull done earlier and never started
#    has already moved the tag under a container still running the old image.
version_file="$(cat VERSION 2>/dev/null || true)"
containers="$(docker compose ps -aq 2>/dev/null || true)"
running=""
if [ -n "$containers" ]; then
  # One id per word, unquoted on purpose.
  # shellcheck disable=SC2086
  running="$(docker container inspect --format \
    '{{index .Config.Labels "com.docker.compose.service"}} {{.Config.Image}} revision={{with index .Config.Labels "org.opencontainers.image.revision"}}{{.}}{{else}}(none){{end}} image={{.Image}}' \
    $containers 2>/dev/null || true)"
fi
{
  echo "# What this deployment ran when scripts/upgrade.sh began, $stamp, before its pull."
  echo "# IMAGE_TAG in .env when it began: $env_tag"
  echo "# VERSION in $root when it began:"
  printf '%s\n' "${version_file:-(there was no VERSION file)}"
  echo "# Every container: service, the image it was created from, that image's revision, image id:"
  printf '%s\n' "${running:-(no container could be read)}"
  echo "# docker compose images:"
  docker compose images 2>/dev/null || true
} >"$inventory"

# The version to go back to, when the record says it — two readings, and nothing guessed past them:
#  - every container of this product was created from one vX.Y.Z tag: that is the version. It is
#    what a pinned deployment ran, whatever .env says now — .env names where this run is going, since
#    that is the one place a version is chosen.
#  - VERSION names a vX.Y.Z channel and its revision is every one of those images' revision: that
#    release is the build that ran. This is how a deployment on `stable` is told, when its bundle
#    was not refreshed ahead of this run.
# Otherwise the rollback says so, and names the revision to look the release up by.
is_release() {
  case "$1" in
    '' | *[[:space:]]*) return 1 ;;
  esac
  printf '%s\n' "$1" | grep -Eqx 'v[0-9][0-9A-Za-z._-]*'
}
ours="$(printf '%s\n' "$running" | awk '$2 ~ /\/openbot-/' || true)"
our_tags="$(printf '%s\n' "$ours" | awk 'NF { n = split($2, part, ":"); print part[n] }' | sort -u)"
our_revisions="$(printf '%s\n' "$ours" | awk 'NF { print $3 }' | sort -u)"
# `|| true`: `head` may close the pipe on a second matching line, and under pipefail that would end
# the upgrade over a line of bookkeeping.
version_revision="$(printf '%s\n' "$version_file" | sed -n 's/^revision=//p' | head -n 1 || true)"
version_channel="$(printf '%s\n' "$version_file" | sed -n 's/^channel=//p' | head -n 1 || true)"
rollback_tag=""
if is_release "$our_tags"; then
  rollback_tag="$our_tags"
elif is_release "$version_channel" && [ -n "$version_revision" ] &&
  [ "$our_revisions" = "revision=$version_revision" ]; then
  rollback_tag="$version_channel"
fi

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
