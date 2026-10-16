import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { hubCursor } from "../db/schema";

/**
 * Where this VM is in the hub's events, or null when it has no place in THIS hub's sequence yet —
 * never read before, or last read at another hub (`db/schema/hub.ts` says why that is not a place).
 */
export async function readHubCursor(
  database: Database,
  hub: string,
): Promise<number | null> {
  const [row] = await database
    .select({ hub: hubCursor.hub, seq: hubCursor.seq })
    .from(hubCursor);
  return row && row.hub === hub ? Number(row.seq) : null;
}

/**
 * Moves the place forward, and only forward: two writers racing (a socket frame and a catch-up
 * page) cannot leave it behind where one of them already read.
 */
export async function writeHubCursor(
  database: Database,
  hub: string,
  seq: number,
): Promise<void> {
  await database
    .insert(hubCursor)
    .values({ one: true, hub, seq })
    .onConflictDoUpdate({
      target: hubCursor.one,
      set: {
        hub,
        seq: sql`case when ${hubCursor.hub} = excluded.hub then greatest(${hubCursor.seq}, excluded.seq) else excluded.seq end`,
        updatedAt: sql`now()`,
      },
    });
}
