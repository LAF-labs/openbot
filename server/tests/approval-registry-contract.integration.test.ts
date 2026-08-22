import { afterEach, describe, expect, test } from "bun:test";
import {
  type ApprovalRegistry,
  createApprovalRegistry,
  createDatabaseApprovalRegistry,
} from "../src/computer/approvals";
import { createDatabase } from "../src/db/client";
import { computerApprovals } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * One contract, two registries.
 *
 * The deployment runs the database-backed registry and most of the suite runs the in-memory one,
 * which is the arrangement where a behaviour drifts on one side and nobody finds out until it is in
 * front of a customer. Every rule that matters is therefore asserted against both, from the same
 * text, so "the tests pass" cannot mean "the tests pass against the one nobody ships".
 *
 * The races at the bottom are asserted against the database alone, because they are the reason it
 * exists: a Map cannot have two processes.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const SUBJECT = {
  botId: "sales-bot",
  actor: "driver@example.test",
  rule: 'contains(element.name, "submit")',
  question: "Place the order?",
  fingerprint: "fp-place-order",
  target: { type: "computer", id: "default" },
};

afterEach(async () => {
  await database.delete(computerApprovals);
});

const REGISTRIES: [string, () => ApprovalRegistry][] = [
  ["in memory", () => createApprovalRegistry()],
  ["in the database", () => createDatabaseApprovalRegistry(database)],
];

for (const [name, build] of REGISTRIES) {
  describe(`an approval registry ${name}`, () => {
    test("spends a granted approval on the action it was granted for", async () => {
      const registry = build();
      const pending = await registry.request(SUBJECT);
      await registry.answer(pending.id, SUBJECT.botId, "boss", true);

      const spent = await registry.consume(pending.id, SUBJECT.fingerprint);
      expect(spent.ok).toBe(true);
      if (spent.ok) expect(spent.approval.answeredBy).toBe("boss");
    });

    test("refuses a different action, which is the whole point of it", async () => {
      const registry = build();
      const pending = await registry.request(SUBJECT);
      await registry.answer(pending.id, SUBJECT.botId, "boss", true);

      const elsewhere = await registry.consume(pending.id, "fp-delete-account");
      expect(elsewhere.ok).toBe(false);
      if (!elsewhere.ok) expect(elsewhere.reason).toBe("a different action");

      // The grant survives the failed replay, so the person's yes is not lost with it.
      expect((await registry.consume(pending.id, SUBJECT.fingerprint)).ok).toBe(
        true,
      );
    });

    test("is good exactly once", async () => {
      const registry = build();
      const pending = await registry.request(SUBJECT);
      await registry.answer(pending.id, SUBJECT.botId, "boss", true);

      expect((await registry.consume(pending.id, SUBJECT.fingerprint)).ok).toBe(
        true,
      );
      const again = await registry.consume(pending.id, SUBJECT.fingerprint);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.reason).toBe("unknown");
    });

    test("cannot be spent before anybody has answered", async () => {
      const registry = build();
      const pending = await registry.request(SUBJECT);

      const early = await registry.consume(pending.id, SUBJECT.fingerprint);
      expect(early.ok).toBe(false);
      if (!early.ok) expect(early.reason).toBe("unanswered");
    });

    test("treats a No as an answer, and a final one", async () => {
      const registry = build();
      const pending = await registry.request(SUBJECT);
      await registry.answer(pending.id, SUBJECT.botId, "boss", false);

      const declined = await registry.consume(pending.id, SUBJECT.fingerprint);
      expect(declined.ok).toBe(false);
      if (!declined.ok) expect(declined.reason).toBe("declined");
    });

    test("cannot be answered twice, so a decision cannot be overturned", async () => {
      const registry = build();
      const pending = await registry.request(SUBJECT);

      expect(
        (await registry.answer(pending.id, SUBJECT.botId, "boss", true)).ok,
      ).toBe(true);
      const second = await registry.answer(
        pending.id,
        SUBJECT.botId,
        "someone-else",
        false,
      );
      expect(second.ok).toBe(false);
    });

    test("keeps one Bot's questions out of another's list", async () => {
      const registry = build();
      await registry.request(SUBJECT);

      expect(await registry.pending(SUBJECT.botId)).toHaveLength(1);
      expect(await registry.pending("research-bot")).toEqual([]);
    });

    test("cannot be answered from another Bot's address", async () => {
      const registry = build();
      const pending = await registry.request(SUBJECT);

      const elsewhere = await registry.answer(
        pending.id,
        "research-bot",
        "boss",
        true,
      );
      expect(elsewhere.ok).toBe(false);
    });

    test("runs out, and stops being spendable when it does", async () => {
      let clock = 1_000_000;
      const registry =
        name === "in memory"
          ? createApprovalRegistry({ now: () => clock, ttlMs: 60_000 })
          : createDatabaseApprovalRegistry(database, {
              now: () => clock,
              ttlMs: 60_000,
            });
      const pending = await registry.request(SUBJECT);
      await registry.answer(pending.id, SUBJECT.botId, "boss", true);

      clock += 60_001;
      expect(await registry.pending(SUBJECT.botId)).toEqual([]);
      const late = await registry.consume(pending.id, SUBJECT.fingerprint);
      expect(late.ok).toBe(false);
    });
  });
}

/**
 * What only the shared store can do.
 *
 * Each registry here stands for one server process. Two of them over one database is the deployment;
 * two Maps is the bug.
 */
describe("two processes over one registry", () => {
  test("let a question raised on one be answered on the other", async () => {
    const raised = createDatabaseApprovalRegistry(database);
    const answered = createDatabaseApprovalRegistry(database);

    const pending = await raised.request(SUBJECT);
    const outcome = await answered.answer(
      pending.id,
      SUBJECT.botId,
      "boss",
      true,
    );

    expect(outcome.ok).toBe(true);
    // And the process holding the turn can spend what the other process's answer granted.
    expect((await raised.consume(pending.id, SUBJECT.fingerprint)).ok).toBe(
      true,
    );
  });

  test("let only one of them spend a grant", async () => {
    const a = createDatabaseApprovalRegistry(database);
    const b = createDatabaseApprovalRegistry(database);
    const pending = await a.request(SUBJECT);
    await a.answer(pending.id, SUBJECT.botId, "boss", true);

    const [first, second] = await Promise.all([
      a.consume(pending.id, SUBJECT.fingerprint),
      b.consume(pending.id, SUBJECT.fingerprint),
    ]);

    expect([first?.ok, second?.ok].filter(Boolean)).toHaveLength(1);
  });

  test("let only one of them answer", async () => {
    const a = createDatabaseApprovalRegistry(database);
    const b = createDatabaseApprovalRegistry(database);
    const pending = await a.request(SUBJECT);

    const [yes, no] = await Promise.all([
      a.answer(pending.id, SUBJECT.botId, "boss", true),
      b.answer(pending.id, SUBJECT.botId, "deputy", false),
    ]);

    expect([yes?.ok, no?.ok].filter(Boolean)).toHaveLength(1);
  });
});
