import { sql } from "drizzle-orm";
import type { HubVersions } from "../../shared/hub/protocol";
import type { HubDatabase, HubTransaction } from "./db/client";
import { hubVersions } from "./db/schema";

export type VersionKind = keyof HubVersions;

/**
 * Raises one collection's version inside the caller's transaction and returns the new number.
 *
 * The upsert's row lock is what orders two writers: the second waits for the first to commit and
 * then reads its number, so no two changes share a version and a VM comparing numbers misses none.
 */
export async function bumpVersion(
  tx: HubTransaction,
  kind: VersionKind,
): Promise<number> {
  const [row] = await tx
    .insert(hubVersions)
    .values({ kind, version: 1 })
    .onConflictDoUpdate({
      target: hubVersions.kind,
      set: { version: sql`${hubVersions.version} + 1` },
    })
    .returning({ version: hubVersions.version });
  if (!row) throw new Error("hub_versions upsert returned nothing");
  return row.version;
}

/** Every collection's version; 0 for one that has never changed. */
export async function readVersions(
  database: HubDatabase | HubTransaction,
): Promise<HubVersions> {
  const rows = await database
    .select({ kind: hubVersions.kind, version: hubVersions.version })
    .from(hubVersions);
  const of = (kind: VersionKind) =>
    rows.find((row) => row.kind === kind)?.version ?? 0;
  return { skills: of("skills"), memory: of("memory") };
}
