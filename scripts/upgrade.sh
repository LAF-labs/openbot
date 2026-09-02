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

say "Dumping the database to $dump"
mkdir -p "$backup_dir"
# -T because there is no terminal here, and without it `exec` allocates one and gzip receives a
# stream with carriage returns in it — a dump that restores as a syntax error, months later.
docker compose exec -T postgres pg_dump -U openbot openbot | gzip >"$dump"
# A dump of nothing succeeds quietly: a container that is not running makes `exec` fail, but an
# empty result from a database that answered does not.
if [ ! -s "$dump" ]; then
  echo "The dump is empty. Refusing to upgrade over a backup that would restore nothing." >&2
  exit 1
fi
ls -l "$dump"

# Exactly what is running right now, by digest. The tag a deployment follows is usually `stable`,
# which MOVES — so "the previous version" is not recoverable from .env after the pull, and this file
# is the only record of what to go back to.
docker compose images >"$inventory" 2>/dev/null || true

say "Pulling images"
docker compose pull

say "Starting"
docker compose up -d

say "Waiting for /health (up to ${health_timeout}s)"
# Asked from inside the API container, which is where the answer is: `server` is deliberately
# unpublished, so there is no port on this host to curl. This is the same request compose's own
# healthcheck makes — the honest one, which probes the database, agent-bot and the computer and
# answers 503 when any of them is down.
deadline=$(( $(date +%s) + health_timeout ))
healthy=false
while [ "$(date +%s)" -lt "$deadline" ]; do
  if docker compose exec -T server bun -e \
    "const r = await fetch('http://localhost:3001/health'); console.log(await r.text()); process.exit(r.ok ? 0 : 1)"; then
    healthy=true
    break
  fi
  sleep 5
done

if [ "$healthy" = true ]; then
  say "Healthy."
  docker compose ps
  exit 0
fi

cat >&2 <<ROLLBACK

== NOT HEALTHY after ${health_timeout}s. The deployment is up and answering 503, or not answering.

What it says, and which dependency is down:

  docker compose exec -T server bun -e "const r = await fetch('http://localhost:3001/health'); console.log(r.status, await r.text())"
  docker compose ps
  docker compose logs server --tail=50

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
  rollback does not come up clean, restore the dump taken at the top of this run:

    zcat $dump | docker compose exec -T postgres psql -U openbot openbot

CAVEAT

exit 1
