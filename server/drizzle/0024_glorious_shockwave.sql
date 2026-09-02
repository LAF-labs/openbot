-- A BOT THE PACKAGE NO LONGER SHIPS IS RELEASED, NOT LEFT STRANDED.
--
-- `synchronizeTenantPackage` did this on every boot, and this statement is the last time anybody
-- will: `agents.yaml` has been an empty list for a while, so the loop that read it had nothing to
-- iterate and its release step released everything each time. `systemOwned` is derived from
-- `package_id`, and all it does is refuse edits and deletion — so a Bot left holding one nobody can
-- change, nobody can remove, and it occupies one of the account's five seats forever. Clearing the
-- id hands it back as an ordinary Bot and keeps every conversation it has had. A change of custody,
-- not of content: no other column is touched, exactly as the loop touched no other column.
UPDATE "agents" SET "package_id" = NULL, "updated_at" = now() WHERE "package_id" IS NOT NULL;--> statement-breakpoint
-- The upstream knowledge plane: six tables nothing has ever written and one that only stored a
-- Google service-account key nothing ever read. `connector_instances` goes with them; the Google
-- Drive a person can actually connect is the OAuth plugin, which lives in `mcp_servers` and
-- `mcp_user_credentials` and is untouched here.
--
-- `IF EXISTS` on every drop, because `chunks` is no longer created at all: it carried the only
-- `vector` column in the database, and 0000 stopped making it so that a fresh database no longer
-- needs the pgvector image to walk this chain. An older deployment has the table and drops it here;
-- a new one never had it and passes straight through.
DROP TABLE IF EXISTS "chunks" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "connector_cursors" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "connector_instances" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "document_acls" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "documents" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "sync_runs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "webhook_subscriptions" CASCADE;--> statement-breakpoint
-- The watcher, parked until a Tier A customer asks for it (docs/laf/redesign-2026-09.md §7-2). The
-- `laf.watch` contract and its checker stay; the platform-side polling of it does not.
DROP TABLE IF EXISTS "laf_digest_log" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "laf_watch_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "laf_watch_sources" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "public"."acl_effect";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."connector_type";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."sync_status";--> statement-breakpoint
-- `chunks.embedding` was the only `vector` column in the database and it was never queried; the
-- extension it needed is why the Postgres image had to be `pgvector/pgvector:pg17`. Dropped last,
-- after the table that used the type, and `IF EXISTS` because a database restored from a dump made
-- before it was ever installed is a database that never had it.
DROP EXTENSION IF EXISTS vector;
