import { inArray } from "drizzle-orm";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createDatabaseRepeatDetector,
  createRepeatDetector,
  type RepeatDetector,
  type RepeatDetectorOptions,
} from "../src/computer/repeat";
import { createDatabase } from "../src/db/client";
import { computerRepeatCalls, computerRepeatReports } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

/**
 * One contract, two detectors.
 *
 * The deployment counts in the database and most of the suite counts in a Map. Asserting the rules
 * against only one of them is how a behaviour drifts on the side that ships, so every rule that a
 * policy can be written against is stated once here and run against both.
 *
 * The caps are not in this file. They bound the Map's memory and have no counterpart in a table whose
 * rows delete themselves at the edge of the window; `computer-repeat.test.ts` still holds them.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const CLICK = { tool: "computer_click", ref: "e9" };

// This file's Bots only: unscoped, this wiped the repeat counters of the database the app is using.
const BOTS = ["bot", "sales-bot", "research-bot"];
afterEach(async () => {
  await database
    .delete(computerRepeatCalls)
    .where(inArray(computerRepeatCalls.botId, BOTS));
  await database
    .delete(computerRepeatReports)
    .where(inArray(computerRepeatReports.botId, BOTS));
});

type Build = (options: RepeatDetectorOptions) => RepeatDetector;

const DETECTORS: [string, Build][] = [
  ["in memory", (options) => createRepeatDetector(options)],
  [
    "in the database",
    (options) => createDatabaseRepeatDetector(database, options),
  ],
];

for (const [name, build] of DETECTORS) {
  describe(`a repeat detector ${name}`, () => {
    test("counts identical calls up, including the one being observed", async () => {
      const detector = build({});
      expect((await detector.observe("sales-bot", CLICK)).count).toBe(1);
      expect((await detector.observe("sales-bot", CLICK)).count).toBe(2);
      expect((await detector.observe("sales-bot", CLICK)).count).toBe(3);
    });

    test("treats a different argument as a different call", async () => {
      const detector = build({});
      await detector.observe("sales-bot", CLICK);
      await detector.observe("sales-bot", CLICK);
      const other = await detector.observe("sales-bot", {
        tool: "computer_click",
        ref: "e1",
      });
      expect(other.count).toBe(1);
    });

    test("keeps one Bot's count away from another's", async () => {
      const detector = build({});
      await detector.observe("sales-bot", CLICK);
      await detector.observe("sales-bot", CLICK);
      expect((await detector.observe("research-bot", CLICK)).count).toBe(1);
    });

    test("lets the window expire, and starts the count again", async () => {
      let clock = 1_000_000;
      const detector = build({ windowMs: 60_000, now: () => clock });
      await detector.observe("bot", CLICK);
      expect((await detector.observe("bot", CLICK)).count).toBe(2);

      clock += 60_001;
      expect((await detector.observe("bot", CLICK)).count).toBe(1);
    });

    test("fires each threshold exactly once", async () => {
      const detector = build({ thresholds: [3] });
      const fired: (number | null)[] = [];
      for (let i = 0; i < 5; i += 1) {
        fired.push((await detector.observe("bot", CLICK)).threshold);
      }
      expect(fired).toEqual([null, null, 3, null, null]);
    });

    test("reports a Bot that gets stuck twice, twice", async () => {
      let clock = 1_000_000;
      const detector = build({
        windowMs: 60_000,
        thresholds: [2],
        now: () => clock,
      });
      await detector.observe("bot", CLICK);
      expect((await detector.observe("bot", CLICK)).threshold).toBe(2);

      clock += 60_001;
      await detector.observe("bot", CLICK);
      expect((await detector.observe("bot", CLICK)).threshold).toBe(2);
    });

    test("does not count a call with nothing to distinguish it", async () => {
      const detector = build({});
      const seen = await detector.observe("bot", { tool: "computer_scroll" });
      expect(seen.fingerprint).toBeNull();
      expect(seen.threshold).toBeNull();
    });
  });
}

/**
 * What only the shared store can do.
 *
 * Each detector stands for one server process. Two of them over one database is the deployment that
 * a rule like `repeat.count >= 4` was written for; two Maps is the bug, where each process sees two
 * and the rule never fires.
 */
describe("two processes counting one Bot", () => {
  test("add their counts up rather than each seeing a fraction", async () => {
    const a = createDatabaseRepeatDetector(database, {});
    const b = createDatabaseRepeatDetector(database, {});

    await a.observe("bot", CLICK);
    await b.observe("bot", CLICK);
    await a.observe("bot", CLICK);
    expect((await b.observe("bot", CLICK)).count).toBe(4);
  });

  test("file one incident between them, not one each", async () => {
    const a = createDatabaseRepeatDetector(database, { thresholds: [2] });
    const b = createDatabaseRepeatDetector(database, { thresholds: [2] });

    await a.observe("bot", CLICK);
    const fired = [
      (await b.observe("bot", CLICK)).threshold,
      (await a.observe("bot", CLICK)).threshold,
      (await b.observe("bot", CLICK)).threshold,
    ];

    expect(fired.filter((value) => value === 2)).toHaveLength(1);
  });
});
