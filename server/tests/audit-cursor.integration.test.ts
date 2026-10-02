import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createAuditReader } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * WALKING THE TRAIL WITH THE CURSOR THE READER ITSELF HANDS OUT.
 *
 * `created_at` is `timestamptz DEFAULT now()`, which keeps microseconds, and no caller supplies it.
 * The driver hands the column back as a JavaScript `Date`, which keeps milliseconds. A cursor made
 * from that `Date` therefore named a moment slightly BEFORE the row it was taken from, and every
 * row written in the same millisecond as a page's last row — every row of one transaction shares
 * `now()` exactly — compared as newer than the cursor and was on no page at all. Nothing said so:
 * the next page was simply shorter than the trail.
 *
 * From upstream OpenBot (#586, MIT), with its two cases, and the one this fork's own writers make
 * every day: several rows from one transaction.
 *
 * NOTHING HERE CLEANS UP, AND CANNOT, for the reason `audit-append-only.integration.test.ts` gives:
 * the database refuses a delete on this table. The rows land in the test database, under a target
 * type that names this file and a target id of this run's own, which is also what every read below
 * is scoped by.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:55432/openbot",
  TEST_POOL,
);

afterAll(async () => {
  await database.$client.close();
});

const reader = createAuditReader(database);

const TARGET_TYPE = "audit_cursor_test";

const row = (targetId: string, note: string) => ({
  eventType: "configuration.changed",
  targetType: TARGET_TYPE,
  targetId,
  payload: { note: `audit-cursor.integration.test.ts — ${note}` },
});

/** Every row of one target, by the pages the reader hands out, in the order it hands them out. */
async function walk(targetId: string, limit: number) {
  const seen: string[] = [];
  let cursor: string | undefined;
  // Bounded, so a cursor that stopped moving fails the assertion instead of hanging the file.
  for (let page = 0; page < 10; page += 1) {
    const result = await reader.list({
      targetId,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    seen.push(...result.events.map((event) => event.id));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return seen;
}

describe("a page boundary inside one transaction", () => {
  test("three rows written together are each on a page", async () => {
    const targetId = `one-transaction-${randomUUID()}`;
    const written = await database.transaction(async (transaction) => {
      const ids: string[] = [];
      for (const note of ["first", "second", "third"]) {
        const [inserted] = await transaction
          .insert(auditEvents)
          .values(row(targetId, note))
          .returning({ id: auditEvents.id });
        if (inserted) ids.push(inserted.id);
      }
      return ids;
    });
    expect(written).toHaveLength(3);

    const first = await reader.list({ targetId, limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).toBeString();

    const second = await reader.list({
      targetId,
      limit: 2,
      cursor: first.nextCursor,
    });

    // The third row. It was on neither page: `now()` is the same instant for the whole
    // transaction, and the cursor's millisecond was earlier than that instant's microseconds.
    expect(second.events).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(
      [...first.events, ...second.events].map((event) => event.id).sort(),
    ).toEqual([...written].sort());
  });
});

describe("a cursor over rows written within one millisecond", () => {
  /** Rows in one statement, at the given microsecond offsets into the statement's millisecond. */
  async function rowsAt(targetId: string, micros: number[]) {
    return database
      .insert(auditEvents)
      .values(
        micros.map((offset) => ({
          ...row(targetId, `+${offset}µs`),
          createdAt: sql`date_trunc('milliseconds', now()) + ${offset}::int * interval '1 microsecond'`,
        })),
      )
      .returning({ id: auditEvents.id });
  }

  test("reaches every row, newest first, when they are microseconds apart", async () => {
    const targetId = `microseconds-${randomUUID()}`;
    const [newest, middle, oldest] = await rowsAt(targetId, [789, 456, 123]);

    expect(await walk(targetId, 1)).toEqual([
      newest?.id,
      middle?.id,
      oldest?.id,
    ] as string[]);
  });

  test("reaches every row when they share one instant", async () => {
    const targetId = `one-instant-${randomUUID()}`;
    const rows = await rowsAt(targetId, [456, 456, 456]);
    // One instant, so the id alone orders them, descending as the reader does.
    const expected = rows
      .map((entry) => entry.id)
      .sort()
      .reverse();

    expect(await walk(targetId, 1)).toEqual(expected);
  });
});

describe("a cursor handed out before the microseconds were kept", () => {
  test("still reads: a millisecond is a moment too", async () => {
    const targetId = `older-cursor-${randomUUID()}`;
    await database.insert(auditEvents).values(row(targetId, "only"));
    const [event] = (await reader.list({ targetId, limit: 1 })).events;
    if (!event) throw new Error("the fixture row was not written");

    // The shape the reader used to hand out: the row's own time as a `Date` prints it.
    const older = Buffer.from(
      JSON.stringify({ id: event.id, createdAt: event.createdAt }),
    ).toString("base64url");

    // An app left open across an upgrade holds one of these. It must page, not fail.
    const result = await reader.list({ targetId, limit: 1, cursor: older });
    expect(result.events).toBeArray();
    expect(result.nextCursor).toBeUndefined();
  });
});
