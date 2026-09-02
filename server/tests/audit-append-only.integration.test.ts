import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * THE TRAIL CANNOT BE EDITED, ASSERTED AGAINST A DATABASE THAT IS ACTUALLY RUNNING.
 *
 * What this replaces read `drizzle/0000_schema.sql` and matched three strings in it. That proves
 * somebody wrote the SQL. It says nothing about whether the migration ran, whether a later migration
 * dropped the trigger, or whether the trigger fires — and a trail anybody can edit after the fact
 * answers no question worth asking, which is the entire reason the guarantee exists.
 *
 * Enforced in the database rather than in the application on purpose: the application is not the
 * only thing that can reach this table. So the attempt here is made in SQL, past every line of
 * TypeScript, which is exactly the caller the trigger is for.
 *
 * NOTHING HERE CLEANS UP, AND CANNOT. The row it writes is a row the database will not let anybody
 * delete, which is the property under test. It lands in the test database, which starts empty and is
 * disposable; it is marked with this file's name and a per-run id so it is identifiable as a test
 * row rather than an event that happened.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

const suite = randomUUID();

afterAll(async () => {
  await database.$client.close();
});

beforeAll(async () => {
  await database.insert(auditEvents).values({
    eventType: "configuration.changed",
    targetType: "test",
    targetId: suite,
    payload: {
      note: "audit-append-only.integration.test.ts — undeletable by design",
    },
  });
});

const rowsHere = () =>
  database.select().from(auditEvents).where(eq(auditEvents.targetId, suite));

/**
 * What PostgreSQL actually said, which is not what the driver throws.
 *
 * Drizzle wraps a failed statement in an error whose message is the SQL it sent and hangs the real
 * one off `cause`. Asserting on the wrapper would pass for a syntax error, a dropped table and a
 * dead connection alike — every way this test could succeed while the guarantee is gone.
 */
async function refusal(attempt: () => Promise<unknown>): Promise<string> {
  try {
    await attempt();
  } catch (error) {
    const reasons: string[] = [];
    for (
      let current: unknown = error;
      current instanceof Error;
      current = current.cause
    ) {
      reasons.push(current.message);
    }
    return reasons.join(" | ");
  }
  throw new Error("The statement succeeded. The trail is not append-only.");
}

describe("the append-only trail", () => {
  test("accepts the row in the first place", async () => {
    // The positive control. Without it, a table that refused inserts too would pass every assertion
    // below by being unreachable rather than by being protected.
    const rows = await rowsHere();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventType).toBe("configuration.changed");
  });

  test("refuses an UPDATE, from SQL, past every line of TypeScript", async () => {
    const said = await refusal(() =>
      database.execute(
        sql`update audit_events set event_type = 'credential.revoked'
            where target_id = ${suite}`,
      ),
    );

    // The trigger's own words, so a failure caused by something else — a missing table, a syntax
    // error, a connection that dropped — cannot be mistaken for the guarantee holding.
    expect(said).toContain("Audit events are append-only");
    // And it refused BEFORE the row changed, which is what `BEFORE UPDATE` buys.
    expect((await rowsHere())[0]?.eventType).toBe("configuration.changed");
  });

  test("refuses a DELETE the same way", async () => {
    const said = await refusal(() =>
      database.delete(auditEvents).where(eq(auditEvents.targetId, suite)),
    );

    expect(said).toContain("Audit events are append-only");
    expect(await rowsHere()).toHaveLength(1);
  });

  test("refuses a DELETE that names no row in particular", async () => {
    // `FOR EACH ROW` means an empty match is silently allowed, so the shape of the attempt matters:
    // a sweep of the whole table is the one somebody reaches for, and it must not succeed because it
    // was written broadly rather than narrowly.
    const said = await refusal(() =>
      database.execute(sql`delete from audit_events`),
    );

    expect(said).toContain("Audit events are append-only");
    expect(await rowsHere()).toHaveLength(1);
  });

  test("the trigger is on the table itself, and fires before the write", async () => {
    // Read from the catalogue, so a migration that dropped or replaced it is visible here rather
    // than only through a refusal that some other constraint might also have produced.
    const rows = await database.execute<{
      timing: string;
      events: string;
      enabled: string;
    }>(
      sql`select action_timing as timing,
                 string_agg(event_manipulation, ',' order by event_manipulation) as events,
                 'yes' as enabled
          from information_schema.triggers
          where event_object_table = 'audit_events'
            and trigger_name = 'audit_events_append_only'
          group by action_timing`,
    );

    expect([...rows]).toEqual([
      { timing: "BEFORE", events: "DELETE,UPDATE", enabled: "yes" },
    ]);
  });
});
