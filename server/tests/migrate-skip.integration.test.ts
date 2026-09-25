import { afterAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { migrationsBehind, newestMigration } from "../scripts/migrate";

/*
 * The `migrate` service's command (server/scripts/migrate.ts), run the way compose runs it, against
 * a database of its own: the first run applies the whole chain through drizzle-kit, and the second
 * finds the newest migration already in the ledger and exits without loading drizzle-kit. That
 * second run is what every later `docker compose up` pays for, so it must be both a no-op and a
 * success, since the server waits for `service_completed_successfully`.
 */

const serverDirectory = resolve(import.meta.dir, "..");
const journal = JSON.parse(
  readFileSync(join(serverDirectory, "drizzle/meta/_journal.json"), "utf8"),
) as { entries: { when: number; tag: string }[] };

test("is behind with no ledger, and with an older newest row", () => {
  const newest = newestMigration(journal);
  expect(newest?.tag).toBe(journal.entries.at(-1)?.tag);
  expect(migrationsBehind(journal, null)).toBe(true);
  expect(migrationsBehind(journal, (newest?.when ?? 0) - 1)).toBe(true);
  expect(migrationsBehind(journal, newest?.when ?? 0)).toBe(false);
  expect(migrationsBehind({ entries: [] }, null)).toBe(false);
});

const testUrl = new URL(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
);
const scratch = `${decodeURIComponent(testUrl.pathname.slice(1)).slice(0, 40)}_mskip_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const maintenanceUrl = new URL(testUrl);
maintenanceUrl.pathname = "/postgres";
const admin = new SQL(maintenanceUrl.toString(), { max: 1 });
const scratchUrl = new URL(testUrl);
scratchUrl.pathname = `/${scratch}`;

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await admin.close();
});

async function runMigrate(): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["bun", "scripts/migrate.ts"], {
    cwd: serverDirectory,
    env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out: `${out}${err}` };
}

test("applies the chain once, then skips it", async () => {
  await admin.unsafe(`CREATE DATABASE "${scratch}"`);

  const first = await runMigrate();
  expect(first.code).toBe(0);
  expect(first.out).not.toContain("migrations up to date");

  const database = new SQL(scratchUrl.toString(), { max: 1 });
  try {
    const [row] =
      await database`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(row.n).toBe(journal.entries.length);
  } finally {
    await database.close();
  }

  const second = await runMigrate();
  expect(second.code).toBe(0);
  expect(second.out).toContain(
    `migrations up to date (${journal.entries.at(-1)?.tag})`,
  );
}, 120_000);
