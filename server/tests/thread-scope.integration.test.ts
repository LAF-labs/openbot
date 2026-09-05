/**
 * A conversation belongs to the person whose it is, and the thread reads say so.
 *
 * The two reads behind CopilotKit's thread routes had no owner in them at all. `threadSummaries`
 * selected every thread in the DEPLOYMENT and `/threads` served it; `prime` read whatever thread the
 * path named and `getThreadMessages` handed it back. One VM belongs to one person, but the staff of
 * that business sign in to the same one — so "signed in" was the whole check standing between an
 * employee and the owner's conversations with their Bots.
 *
 * Two real people in a real database, because that is the only way to be sure: every part of this —
 * the join, the ownership row, the primed handoff — is a fact about Postgres and about a vendored
 * in-memory store that outlives the request.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  channels,
  channelThreads,
  lafThreadMessages,
  users,
} from "../src/db/schema";
import { LafPostgresRunner } from "../src/runner/laf-runner";
import { createRunLedger } from "../src/runner/run-ledger";
import {
  appendMessages,
  isThreadOwnedBy,
  type StoredMessage,
  threadSummaries,
} from "../src/runner/thread-store";
import { TEST_POOL } from "./support/database";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("whose threads a thread read answers with", () => {
  const database = createDatabase(databaseUrl ?? "", TEST_POOL);
  const run = randomUUID().slice(0, 8);

  /** The business owner and one of their staff, on the one VM they share. */
  const OWNER = `thread-scope-owner-${run}`;
  const STAFF = `thread-scope-staff-${run}`;
  const ownerThread = `thread-scope-owner-thread-${run}`;
  const staffThread = `thread-scope-staff-thread-${run}`;
  const ownerChannel = `thread-scope-owner-channel-${run}`;
  const staffChannel = `thread-scope-staff-channel-${run}`;

  const said = (id: string) =>
    ({ id, role: "user", content: id }) as unknown as StoredMessage;

  // Only what this file made: two users, two channels, two threads, by identity.
  afterAll(async () => {
    await database
      .delete(lafThreadMessages)
      .where(inArray(lafThreadMessages.threadId, [ownerThread, staffThread]));
    await database
      .delete(channelThreads)
      .where(inArray(channelThreads.userId, [OWNER, STAFF]));
    await database
      .delete(channels)
      .where(inArray(channels.id, [ownerChannel, staffChannel]));
    await database.delete(users).where(inArray(users.id, [OWNER, STAFF]));
    await database.$client.close();
  });

  test("prepares two people with one conversation each", async () => {
    await database.insert(users).values([
      { id: OWNER, email: `${OWNER}@laf.test`, name: "Owner" },
      { id: STAFF, email: `${STAFF}@laf.test`, name: "Staff" },
    ]);
    await database.insert(channels).values([
      { id: ownerChannel, name: "Owner", description: "owner" },
      { id: staffChannel, name: "Staff", description: "staff" },
    ]);
    await database.insert(channelThreads).values([
      { userId: OWNER, channelId: ownerChannel, threadId: ownerThread },
      { userId: STAFF, channelId: staffChannel, threadId: staffThread },
    ]);
    await appendMessages(database, ownerThread, [said("owner-said-this")]);
    await appendMessages(database, staffThread, [said("staff-said-this")]);

    expect(await isThreadOwnedBy(database, ownerThread, OWNER)).toBe(true);
    expect(await isThreadOwnedBy(database, ownerThread, STAFF)).toBe(false);
    // A thread nothing recorded an owner for belongs to nobody, not to everybody.
    expect(await isThreadOwnedBy(database, `no-such-${run}`, OWNER)).toBe(
      false,
    );
  });

  test("the thread list holds one person's threads and not the other's", async () => {
    const mine = await threadSummaries(database, OWNER);
    const theirs = await threadSummaries(database, STAFF);

    expect(mine.map((summary) => summary.threadId)).toContain(ownerThread);
    expect(mine.map((summary) => summary.threadId)).not.toContain(staffThread);
    expect(theirs.map((summary) => summary.threadId)).toContain(staffThread);
    expect(theirs.map((summary) => summary.threadId)).not.toContain(
      ownerThread,
    );
  });

  test("priming refuses somebody else's thread, and primes your own", async () => {
    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
    );

    expect(await runner.prime(ownerThread, OWNER)).toBe(true);
    expect(runner.getThreadMessages(ownerThread).map((m) => m.id)).toEqual([
      "owner-said-this",
    ]);

    /*
     * The refusal, AFTER a successful prime of the same thread — which is the case that matters.
     * `primed` is one map shared by every request, so a refusal that only declined to add to it
     * would have handed the previous caller's copy to this one.
     */
    expect(await runner.prime(ownerThread, STAFF)).toBe(false);
    expect(runner.getThreadMessages(ownerThread)).toEqual([]);
  });

  test("the list a person is served carries no thread of anybody else's", async () => {
    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
    );

    await runner.primeThreadList(STAFF);
    const ids = runner.listThreads().map((thread) => thread.id);
    expect(ids).toContain(staffThread);
    expect(ids).not.toContain(ownerThread);

    await runner.primeThreadList(OWNER);
    const theirs = runner.listThreads().map((thread) => thread.id);
    expect(theirs).toContain(ownerThread);
    expect(theirs).not.toContain(staffThread);
  });

  test("a person with no threads is served an empty list, not the deployment's", async () => {
    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
    );

    await runner.primeThreadList(`nobody-${run}`);
    const ids = runner.listThreads().map((thread) => thread.id);
    expect(ids).not.toContain(ownerThread);
    expect(ids).not.toContain(staffThread);
  });

  test("a thread with no owner row is refused rather than read", async () => {
    const orphan = `thread-scope-orphan-${run}`;
    const runner = await LafPostgresRunner.create(
      database,
      createRunLedger(database),
    );

    expect(await runner.prime(orphan, OWNER)).toBe(false);
    expect(runner.getThreadMessages(orphan)).toEqual([]);
    // Nothing was written, so there is nothing to clean up — asserted rather than assumed.
    const rows = await database
      .select({ threadId: lafThreadMessages.threadId })
      .from(lafThreadMessages)
      .where(eq(lafThreadMessages.threadId, orphan));
    expect(rows).toEqual([]);
  });
});
