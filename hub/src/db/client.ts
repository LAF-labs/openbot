import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * The hub's database, on the `postgres` driver rather than `bun:sql`.
 *
 * The product's server runs two `bun:sql` pools because Bun before 1.4.0 can send a plain query
 * down a connection a transaction holds (server/src/db/client.ts says how that was measured). The
 * hub opens a transaction for every write it makes — the event, the idempotency row and the trail
 * row commit together — so it takes the driver whose transactions own their connection outright.
 */
export function createHubDatabase(url: string, options: { max?: number } = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    // A notice per `create … if not exists` in a test is noise in the gate's output.
    onnotice: () => {},
  });
  const database = drizzle(client, { schema });
  return Object.assign(database, {
    close: () => client.end({ timeout: 5 }),
  });
}

export type HubDatabase = ReturnType<typeof createHubDatabase>;
export type HubTransaction = Parameters<
  Parameters<HubDatabase["transaction"]>[0]
>[0];

/** The migration chain beside this source, in the image and in a checkout alike. */
export const HUB_MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

/**
 * Applies what is missing, at boot. The hub has no separate migrate step: it is one process with
 * one database, and starting it is when its schema has to be right. Drizzle's ledger makes a run
 * with nothing to apply one read.
 */
export async function migrateHub(database: HubDatabase): Promise<void> {
  await migrate(database, { migrationsFolder: HUB_MIGRATIONS });
}
