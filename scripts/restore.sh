#!/usr/bin/env bash
#
# Restore a dump BESIDE the live database, count every table on both sides, and only on --replace
# swap the two — so a restore is something you look at before it is something you have done.
#
# The bare form in deploying.md — `zcat dump | psql openbot` — restores INTO the live database:
# every row that arrived since the dump is gone the moment it finishes, and if the dump turns out
# to be the wrong day's, or empty, or from before a migration, that is discovered afterwards, on top
# of the data it replaced. This restores into a database of its own, prints the row counts of both
# side by side, and stops. The swap is a second decision, made with the table in front of you.
#
#   scripts/restore.sh <dump.sql.gz>             # restore into openbot_restore, print the counts
#   scripts/restore.sh latest                    # the newest dump in BACKUP_DIR (or OFFSITE_BUCKET)
#   scripts/restore.sh <dump> --fresh            # drop a previous openbot_restore first
#   scripts/restore.sh <dump> --replace          # …then stop the API, swap the names, start, /health
#   scripts/restore.sh <dump> --replace --yes    # the same without the typed confirmation (a job, not a person)
#   scripts/restore.sh <dump> --dry-run          # say what would happen; open no connection at all
#
# Environment:
#   BACKUP_DIR       where the dumps are (default /var/backups/laf — the backup script's directory)
#   OFFSITE_BUCKET   with `latest`: pull the newest object from this bucket first (needs the oci CLI
#                    and the operator's credentials — the VM only holds a WRITE-only door, so this
#                    is a laptop-side path; OFFSITE_REGION names the bucket's region)
#   LIVE_DB          the database compared against and, with --replace, replaced (default openbot)
#   RESTORE_DB       the database restored into (default openbot_restore)
#   PG_URL           a maintenance URL — postgres://user:pass@host:port/postgres, no query string —
#                    to use the local psql instead of `docker compose exec -T postgres`
#   HEALTH_TIMEOUT   seconds to wait for /health after --replace (default 180)
#
# The live database is never written without --replace: it is read for its row counts and nothing
# else. Re-running is safe — a target that already holds a restore is refused until --fresh says to
# drop it, and --replace keeps the previous live database under a dated name rather than dropping it.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

backup_dir="${BACKUP_DIR:-/var/backups/laf}"
live_db="${LIVE_DB:-openbot}"
restore_db="${RESTORE_DB:-openbot_restore}"
pg_user="${POSTGRES_USER:-openbot}"
pg_url="${PG_URL:-}"
offsite_bucket="${OFFSITE_BUCKET:-}"
offsite_region="${OFFSITE_REGION:-}"
health_timeout="${HEALTH_TIMEOUT:-180}"

say() { printf '\n== %s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
usage() {
  sed -n '/^#   scripts\/restore.sh/,/^#$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

replace=false
fresh=false
dry_run=false
yes=false
source=""
for argument in "$@"; do
  case "$argument" in
    --replace) replace=true ;;
    --fresh) fresh=true ;;
    --dry-run) dry_run=true ;;
    --yes) yes=true ;;
    -h | --help) usage; exit 0 ;;
    --*) die "Unknown option: $argument" ;;
    *)
      [ -z "$source" ] || die "One dump at a time: got both '$source' and '$argument'."
      source="$argument"
      ;;
  esac
done
if [ -z "$source" ]; then
  usage >&2
  exit 64
fi

# --- names, checked before anything is dialled ---------------------------------------------------

# Both names reach CREATE/ALTER/DROP DATABASE as identifiers. Held to the characters that need no
# quoting rather than quoted, because a name that needs quoting here is a name somebody mistyped.
for name in "$live_db" "$restore_db"; do
  if ! printf '%s' "$name" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$'; then
    die "'$name' is not a database name this script will use: lowercase letters, digits and underscores, 63 at most."
  fi
done
if [ "$live_db" = "$restore_db" ]; then
  die "LIVE_DB and RESTORE_DB are both '$live_db'. The whole point is that they differ."
fi
if [ -n "$pg_url" ] && printf '%s' "$pg_url" | grep -q '?'; then
  die "PG_URL carries a query string; this script appends the database name to it and cannot. Drop the '?…' part."
fi

# --- which dump ----------------------------------------------------------------------------------

fetch_latest_from_bucket() {
  command -v oci >/dev/null 2>&1 \
    || die "OFFSITE_BUCKET is set but there is no oci CLI on PATH. This path runs on the operator's machine, not on the VM: the VM holds a write-only door and cannot list the bucket."
  local region_args=()
  [ -z "$offsite_region" ] || region_args=(--region "$offsite_region")
  local name
  name="$(SUPPRESS_LABEL_WARNING=True oci os object list "${region_args[@]}" -bn "$offsite_bucket" \
    --fields name,timeCreated --all --query 'max_by(data, &"time-created").name' --raw-output)"
  if [ -z "$name" ] || [ "$name" = "null" ]; then
    die "The bucket $offsite_bucket holds no objects."
  fi
  mkdir -p "$backup_dir/offsite"
  local target="$backup_dir/offsite/$name"
  if [ ! -s "$target" ]; then
    SUPPRESS_LABEL_WARNING=True oci os object get "${region_args[@]}" -bn "$offsite_bucket" --name "$name" --file "$target" >/dev/null
  fi
  printf '%s' "$target"
}

dump=""
dump_origin=""
if [ "$source" != "latest" ]; then
  dump="$source"
  dump_origin="named on the command line"
elif [ -n "$offsite_bucket" ]; then
  if $dry_run; then
    dump="(the newest object in $offsite_bucket, downloaded into $backup_dir/offsite/)"
    dump_origin="the offsite bucket"
  else
    dump="$(fetch_latest_from_bucket)"
    dump_origin="the newest object in $offsite_bucket"
  fi
else
  dump="$(ls -1t "$backup_dir"/laf-*.sql.gz 2>/dev/null | head -1 || true)"
  [ -n "$dump" ] || die "No laf-*.sql.gz in $backup_dir. Name a dump, set BACKUP_DIR, or set OFFSITE_BUCKET to pull one down."
  dump_origin="the newest laf-*.sql.gz in $backup_dir"
fi

# A dump is proven before the plan is printed, dry run included: a file of the right name and the
# wrong content is exactly what a restore at 2am would be fed.
if ! { $dry_run && [ "$dump_origin" = "the offsite bucket" ]; }; then
  [ -s "$dump" ] || die "No such dump, or it is empty: $dump"
  header="$(gzip -dc "$dump" 2>/dev/null | head -c 4096 || true)"
  if ! printf '%s' "$header" | grep -q 'PostgreSQL database dump'; then
    die "$dump does not decompress to a pg_dump: the first lines should say 'PostgreSQL database dump'."
  fi
fi

# --- the plan, and the dry run's exit -----------------------------------------------------------

say "Dump:     $dump ($dump_origin)"
echo "   Into:     $restore_db$($fresh && echo ' (dropped first: --fresh)')"
echo "   Against:  $live_db (row counts only$($replace && echo ', then REPLACED: --replace' || echo '; not touched'))"
if [ -n "$pg_url" ]; then
  echo "   Through:  PG_URL with the local psql"
else
  echo "   Through:  docker compose exec -T postgres"
fi

if $dry_run; then
  say "DRY RUN — nothing was opened, written or replaced."
  if $replace; then
    echo "   With --replace the run would: stop the API, rename $live_db to ${live_db}_before_restore_<stamp>,"
    echo "   rename $restore_db to $live_db, start the API and wait for /health."
  else
    echo "   Without --replace the run ends at the row-count table; $live_db is read and never written."
  fi
  exit 0
fi

# --- one way into Postgres -----------------------------------------------------------------------

# psql against one database. On a deployment the database is reachable only through the compose
# Postgres, so `docker compose exec -T postgres` (-T: no terminal, or the dump gets carriage returns
# and restores as a syntax error). On a laptop, or through a tunnel, PG_URL names a maintenance
# connection and the local psql is used. ON_ERROR_STOP because a dump that half-applies and reports
# success is the failure this script exists to prevent.
psql_in() {
  local db="$1"
  shift
  if [ -n "$pg_url" ]; then
    psql "${pg_url%/*}/$db" -X -q -v ON_ERROR_STOP=1 "$@"
  else
    docker compose exec -T postgres psql -U "$pg_user" -d "$db" -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}
scalar() {
  local db="$1"
  shift
  psql_in "$db" -At -c "$1"
}
database_exists() {
  [ "$(scalar postgres "select count(*) from pg_database where datname = '$1'")" = 1 ]
}
disconnect_everyone_from() {
  scalar postgres "select count(pg_terminate_backend(pid)) from pg_stat_activity where datname = '$1' and pid <> pg_backend_pid()" >/dev/null
}

say "Checking $live_db and $restore_db"
database_exists "$live_db" || die "There is no database named $live_db here. LIVE_DB names the one being compared against."

if database_exists "$restore_db"; then
  held="$(scalar "$restore_db" "select count(*) from pg_tables where schemaname not in ('pg_catalog', 'information_schema')")"
  if [ "$held" != 0 ]; then
    if $fresh; then
      echo "   $restore_db holds $held tables from an earlier run; dropping it (--fresh)."
      disconnect_everyone_from "$restore_db"
      scalar postgres "drop database \"$restore_db\"" >/dev/null
    else
      die "$restore_db already holds $held tables — an earlier run's restore. Read it, or pass --fresh to drop it and restore again. Nothing was done."
    fi
  else
    echo "   $restore_db exists and is empty; restoring into it."
  fi
fi
if ! database_exists "$restore_db"; then
  # template0, as the pg_dump documentation says to: a template1 somebody added an object to would
  # collide with the dump's own CREATE statements.
  scalar postgres "create database \"$restore_db\" template template0" >/dev/null
  echo "   Created $restore_db."
fi

# --- the restore ---------------------------------------------------------------------------------

say "Restoring into $restore_db"
started=$SECONDS
gzip -dc "$dump" | psql_in "$restore_db" >/dev/null
elapsed=$((SECONDS - started))
echo "   Restored in ${elapsed}s."

# --- the table -----------------------------------------------------------------------------------

# Exact counts, one query per database: count(*) on every ordinary table outside the catalogs,
# through query_to_xml so the loop is inside Postgres rather than one round trip per table. The
# drizzle migrations table is in the list on purpose — it is how a dump says which schema it is.
counts_sql="select n.nspname || '.' || c.relname,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
order by 1"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
psql_in "$live_db" -At -F ' ' -c "$counts_sql" | LC_ALL=C sort >"$tmp/live"
psql_in "$restore_db" -At -F ' ' -c "$counts_sql" | LC_ALL=C sort >"$tmp/restore"

say "Row counts: $live_db (live) against $restore_db (restored)"
LC_ALL=C join -a1 -a2 -e '-' -o '0,1.2,2.2' "$tmp/live" "$tmp/restore" | awk -v live="$live_db" -v restore="$restore_db" -v took="$elapsed" '
  BEGIN { printf "   %-46s %10s %10s\n", "table", "live", "restored"; tables = 0; equal = 0 }
  {
    tables += 1
    mark = "DIFF"
    if ($2 == $3) { mark = "="; equal += 1 }
    else if ($2 == "-") mark = "DIFF (restored only)"
    else if ($3 == "-") mark = "DIFF (live only)"
    else mark = sprintf("DIFF (%+d)", $3 - $2)
    printf "   %-46s %10s %10s  %s\n", $1, $2, $3, mark
  }
  END { printf "\n   %d tables · %d equal · %d differ · restore took %ss\n", tables, equal, tables - equal, took }
'

if ! $replace; then
  say "Not replacing anything. $live_db was read for its counts and never written."
  echo "   The restore is in $restore_db for you to look at. To make it the live database:"
  echo "     scripts/restore.sh $source --replace"
  echo "   To try again from the same or another dump: add --fresh."
  exit 0
fi

# --- the swap: only here, only on --replace ------------------------------------------------------

if ! $yes; then
  if [ ! -t 0 ]; then
    die "--replace needs a terminal to confirm on, or --yes. Nothing was replaced; the restore is in $restore_db."
  fi
  printf '\nType the name of the live database (%s) to replace it with %s: ' "$live_db" "$restore_db"
  read -r typed
  [ "$typed" = "$live_db" ] || die "That is not '$live_db'. Nothing was replaced; the restore is in $restore_db."
fi

# Digits only: a database name with a capital letter in it has to be quoted every time it is typed,
# and the kept copy is something a person drops by hand later.
stamp="$(date -u +%Y%m%d%H%M%S)"
kept="${live_db}_before_restore_${stamp}"

if [ -n "$pg_url" ]; then
  say "PG_URL mode: no service to stop here. Whatever serves $live_db must already be stopped."
else
  say "Stopping the API"
  docker compose stop server
fi

say "Renaming $live_db to $kept, then $restore_db to $live_db"
# ALTER DATABASE … RENAME refuses while anybody is connected, and the API was the somebody. Whoever
# is left — a psql, a stray test — is disconnected; the whole point of --replace is that this
# moment belongs to the restore.
disconnect_everyone_from "$live_db"
disconnect_everyone_from "$restore_db"
scalar postgres "alter database \"$live_db\" rename to \"$kept\"" >/dev/null
if ! scalar postgres "alter database \"$restore_db\" rename to \"$live_db\"" >/dev/null; then
  # The first rename went through and the second did not: put the live name back before saying
  # anything, so the deployment is never left without a database called $live_db.
  scalar postgres "alter database \"$kept\" rename to \"$live_db\"" >/dev/null || true
  die "The second rename failed; $live_db was renamed back. Nothing changed. The restore is still in $restore_db."
fi
echo "   Done. The previous live database is kept as $kept."

if [ -z "$pg_url" ]; then
  say "Starting"
  # `up -d server` runs the migration container first (compose: service_completed_successfully), so
  # a dump from before a migration is brought forward, which is the same path an upgrade takes.
  docker compose up -d server

  say "Waiting for /health (up to ${health_timeout}s)"
  deadline=$(($(date +%s) + health_timeout))
  healthy=false
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if docker compose exec -T server bun -e \
      "const r = await fetch('http://localhost:3001/health'); console.log(await r.text()); process.exit(r.ok ? 0 : 1)"; then
      healthy=true
      break
    fi
    sleep 5
  done
  if [ "$healthy" != true ]; then
    cat >&2 <<NOTHEALTHY

== NOT HEALTHY after ${health_timeout}s. The database was swapped; the API is not answering ok.

  docker compose logs server --tail=50

To go back to the database that was live before this run:

  docker compose stop server
  docker compose exec -T postgres psql -U $pg_user -d postgres -c 'alter database "$live_db" rename to "${restore_db}_failed_${stamp}"' -c 'alter database "$kept" rename to "$live_db"'
  docker compose up -d server
NOTHEALTHY
    exit 1
  fi
  say "Healthy."
fi

say "Replaced. When you are sure, drop the kept copy:"
echo "     drop database \"$kept\";"
