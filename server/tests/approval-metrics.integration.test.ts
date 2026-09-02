import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db/client";
import { auditEvents } from "../src/db/schema";
import { readApprovalPairs } from "../src/notifications/approval-metrics";
import { TEST_POOL } from "./support/database";

/**
 * The join, against a real trail.
 *
 * The question and its answer are two rows with different target types (a browser click is filed
 * against the computer, a tool call against the tool) and different actors (whoever was driving,
 * and whoever answered — usually not the same person). The ONLY thing they share is the approval id
 * inside the payload, so the join is the whole of whether this number can be computed at all. It is
 * also the exact thing `db/schema/json.ts` describes going silently wrong: through drizzle's own
 * `jsonb()` the payload lands as a JSON *string* and every `->>` here returns null.
 *
 * ASSERTED BY CONTAINMENT, not by equality on the whole table. `audit_events` is append-only — no
 * test can clean up after itself — so the suite's other files leave `approval.requested` rows in
 * this database and a count assertion here would be a test of what ran before it.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const suite = randomUUID().slice(0, 8);
/** Two hundred days back, so these rows sit outside every other test's window. */
const LONG_AGO = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);

afterAll(async () => {
  await database.$client.close();
});

describe("how long people take to answer", () => {
  test("pairs a question with its answer, and leaves an unanswered one unanswered", async () => {
    const answered = `metrics-answered-${suite}`;
    const ignored = `metrics-unanswered-${suite}`;

    await database.insert(auditEvents).values([
      {
        eventType: "approval.requested",
        targetType: "computer",
        targetId: `computer-${suite}`,
        payload: { bot: `bot-${suite}`, approval: answered },
        createdAt: LONG_AGO,
      },
      {
        // Ninety seconds later, and filed against a different target by a different route — which
        // is why the approval id in the payload is the only thing that can join them.
        eventType: "approval.granted",
        targetType: "mcp_tool",
        targetId: `tool-${suite}`,
        payload: { bot: `bot-${suite}`, approval: answered },
        createdAt: new Date(LONG_AGO.getTime() + 90_000),
      },
      {
        eventType: "approval.requested",
        targetType: "computer",
        targetId: `computer-${suite}`,
        payload: { bot: `bot-${suite}`, approval: ignored },
        createdAt: LONG_AGO,
      },
    ]);

    const pairs = await readApprovalPairs(database, { days: 365 });
    const mine = new Map(pairs.map((pair) => [pair.approvalId, pair]));

    const answeredPair = mine.get(answered);
    expect(answeredPair).toBeDefined();
    expect(answeredPair?.decidedAt).not.toBeNull();
    expect(
      new Date(answeredPair?.decidedAt ?? 0).getTime() -
        new Date(answeredPair?.requestedAt ?? 0).getTime(),
    ).toBe(90_000);

    // Asked and never answered: the row the KPI counts as `unanswered` rather than as fast.
    expect(mine.get(ignored)).toBeDefined();
    expect(mine.get(ignored)?.decidedAt).toBeNull();

    // And the window is a window: two hundred days back is outside a thirty-day question.
    const recent = await readApprovalPairs(database, { days: 30 });
    expect(recent.some((pair) => pair.approvalId === answered)).toBe(false);
  });
});
