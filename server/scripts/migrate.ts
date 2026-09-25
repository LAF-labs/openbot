/**
 * The `migrate` service's command: drizzle-kit's migration, skipped when the database already
 * holds the newest one in the journal.
 *
 * Every `docker compose up` starts this one-shot container again, and the server waits for it to
 * exit. Most of those runs have nothing to apply, and `bun x drizzle-kit migrate` still loads
 * itself to find that out, while the question itself is one row. Measured 2026-09-26 on an A1
 * VM (1 OCPU, `compose run --rm migrate`, database up to date): 1.1 s with drizzle-kit, 0.6 s
 * with this; the 5.0 s the signup research saw was a loaded Docker Desktop. So the row is read first. drizzle-kit's migrator makes the same
 * comparison (the newest `created_at` it recorded against each journal entry's `when`), so "up to
 * date" means here what it means there. A database that cannot answer, a fresh one with no ledger
 * among them, goes to drizzle-kit exactly as before. Applying is still drizzle-kit's job alone,
 * which is what keeps this idempotent: a second run finds the row and exits.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

type Journal = { entries: { when: number; tag: string }[] };

/** The newest journal entry, or null for an empty journal. */
export function newestMigration(
  journal: Journal,
): { when: number; tag: string } | null {
  let newest: { when: number; tag: string } | null = null;
  for (const entry of journal.entries) {
    if (!newest || entry.when > newest.when) newest = entry;
  }
  return newest;
}

/**
 * Whether drizzle-kit has anything to do. `applied` is the newest `created_at` in the ledger,
 * or null when it could not be read.
 */
export function migrationsBehind(
  journal: Journal,
  applied: number | null,
): boolean {
  const newest = newestMigration(journal);
  if (!newest) return false;
  return applied === null || applied < newest.when;
}

async function appliedAt(databaseUrl: string): Promise<number | null> {
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    const [row] = await sql<{ at: string | null }[]>`
      select max(created_at)::text as at from drizzle.__drizzle_migrations`;
    return row?.at ? Number(row.at) : null;
  } catch {
    return null;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set before running a migration");
    process.exit(1);
  }
  const journal = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "drizzle", "meta", "_journal.json"),
      "utf8",
    ),
  ) as Journal;
  if (!migrationsBehind(journal, await appliedAt(databaseUrl))) {
    console.log(
      `migrations up to date (${newestMigration(journal)?.tag ?? "none"})`,
    );
    process.exit(0);
  }
  const run = Bun.spawnSync(
    ["bun", "x", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exit(run.exitCode ?? 1);
}
