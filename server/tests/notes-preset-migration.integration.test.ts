import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { actionPolicy, agents } from "../src/db/schema";
import { computerStandingApprovals } from "../src/db/schema/computer";
import {
  NOTES_PRESET,
  notesPresetMigration,
  presetOnTheScreen,
  RETIRED_NOTES_RULE,
} from "./support/boundary-presets";
import { TEST_POOL } from "./support/database";

/**
 * Migration 0062, run over rows: a stored copy of the boundaries screen's notes preset is rewritten
 * to the rule that preset writes now, an allowance that still stands under the old rule goes with
 * it, and nothing else is touched.
 *
 * The statement is run out of the migration file itself (`support/boundary-presets.ts`), over rows
 * of this file's own, and ALL OF IT INSIDE ONE TRANSACTION THAT IS ROLLED BACK — the rows too. The
 * statement writes every row that holds the old expression, and the rest of the suite's rows are
 * not this file's to touch; and a row of this file's that outlived it would be a second policy row
 * in front of `policy-durability.integration.test.ts`, which reads the table whole and expects the
 * one. So nothing here is ever committed, and no row is called `current`.
 *
 * "LEFT ALONE" IS NOT SOMETHING A ROW'S COLUMNS CAN SAY. `array_replace` over a row that does not
 * hold the expression changes nothing in it, so a statement with no WHERE leaves every column of
 * every row as it was — and still writes them all, on every deployment, on every run. What says a
 * row was written is where its current version sits (`ctid`): PostgreSQL writes a new version of
 * a row for every UPDATE of it, to itself included, and never where the old one is. So the rows
 * that should be written are checked to have moved, or the ones that should not would pass on a
 * signal that never does.
 */

/**
 * Opened by the test, in the database `DATABASE_URL` names — AND IN NO OTHER. Most files here fall
 * back to the address a laptop's own database answers at when the variable is unset. This one runs
 * a migration's statement, which writes every policy row that holds the old rule, whoever's row it
 * is; where that happens is not something to assume. The gate always names one
 * (`scripts/test-ci.ts`), and run alone with none named this fails, in words, having opened nothing.
 */
let database: ReturnType<typeof createDatabase> | undefined;
const run = randomUUID().slice(0, 8);
const id = (name: string) => `m62-${name}-${run}`;

const WAS = RETIRED_NOTES_RULE;
const IS = presetOnTheScreen(NOTES_PRESET);
/** Rules that have nothing to do with it, to be found where they were, in the order they were. */
const SUBMIT = 'intent == "activate" && contains(element.name, "submit")';
const REPEAT = "repeat.count >= 5";
const ENV = 'file.extension == "env"';
const WHEN = new Date("2026-09-30T03:00:00.000Z");

type Seed = {
  id: string;
  deny: string[];
  ask: string[];
  allow: string[];
  settleWithoutAsking: string | null;
  updatedBy: string | null;
};

/** Rows that hold the expression in a list that holds an action back. */
const HOLD_IT: Seed[] = [
  {
    id: id("ask"),
    deny: [ENV],
    ask: [SUBMIT, WAS, REPEAT],
    allow: ["true"],
    settleWithoutAsking: "off",
    updatedBy: "admin@m62.test",
  },
  {
    // In `allow` too, where it stays: swapping it there would permit more than the row did.
    id: id("deny"),
    deny: [WAS],
    ask: [],
    allow: [WAS, "true"],
    settleWithoutAsking: null,
    updatedBy: null,
  },
  {
    id: id("both"),
    deny: [SUBMIT, WAS],
    ask: [WAS, SUBMIT, WAS],
    allow: ["true"],
    settleWithoutAsking: "allowed",
    updatedBy: "owner@m62.test",
  },
];

/** Rows that do not: a rule that only looks like it, the new rule already, `allow` alone, nothing. */
const DO_NOT: Seed[] = [
  {
    id: id("near"),
    deny: [WAS.replace('"write_file"', '"read_file"')],
    ask: [
      `${WAS} `,
      ` ${WAS}`,
      WAS.replace("^notes/", "^Notes/"),
      WAS.replace("^notes/", "^private/"),
      WAS.replace("!matches", "! matches"),
      WAS.toUpperCase(),
      `(${WAS}) || submit`,
      `${WAS} && bot.id == "bot-1"`,
    ],
    allow: ["true"],
    settleWithoutAsking: "off",
    updatedBy: "admin@m62.test",
  },
  {
    id: id("now"),
    deny: [IS],
    ask: [IS, SUBMIT],
    allow: ["true"],
    settleWithoutAsking: null,
    updatedBy: null,
  },
  {
    id: id("allow"),
    deny: [],
    ask: [],
    allow: [WAS, "true"],
    settleWithoutAsking: null,
    updatedBy: "admin@m62.test",
  },
  {
    id: id("none"),
    deny: [],
    ask: [],
    allow: ["true"],
    settleWithoutAsking: null,
    updatedBy: null,
  },
];
const SEEDS = [...HOLD_IT, ...DO_NOT];
const IDS = SEEDS.map((seed) => seed.id);

const columns = {
  id: actionPolicy.id,
  mode: actionPolicy.mode,
  deny: actionPolicy.deny,
  ask: actionPolicy.ask,
  allow: actionPolicy.allow,
  settleWithoutAsking: actionPolicy.settleWithoutAsking,
  updatedBy: actionPolicy.updatedBy,
  updatedAt: actionPolicy.updatedAt,
  /** Which version of the row this is. See the note at the top. */
  version: sql<string>`"action_policy".ctid::text`,
};
type Row = {
  id: string;
  mode: string;
  deny: string[];
  ask: string[];
  allow: string[];
  settleWithoutAsking: string | null;
  updatedBy: string | null;
  updatedAt: Date;
  version: string;
};
type Rows = Record<string, Row>;

const swapped = (rules: string[]) =>
  rules.map((rule) => (rule === WAS ? IS : rule));

afterAll(async () => {
  await database?.$client.close();
});

describe("migration 0062, over rows", () => {
  test("rewrites the old expression where a row holds it in `ask` or `deny`, writes no other row, and a second run writes none at all", async () => {
    // What the seeds are worth: the two expressions differ, and no look-alike is the real thing.
    expect(IS).not.toBe(WAS);
    for (const seed of DO_NOT) {
      expect([...seed.deny, ...seed.ask]).not.toContain(WAS);
    }

    const named = process.env.DATABASE_URL;
    if (!named) {
      throw new Error(
        "DATABASE_URL names no database, and this test does not assume one.",
      );
    }
    const opened = createDatabase(named, TEST_POOL);
    database = opened;

    let before: Rows = {};
    let after: Rows = {};
    let again: Rows = {};
    await opened
      .transaction(async (transaction) => {
        const read = async (): Promise<Rows> =>
          Object.fromEntries(
            (
              await transaction
                .select(columns)
                .from(actionPolicy)
                .where(inArray(actionPolicy.id, IDS))
            ).map((row) => [row.id, row]),
          );
        await transaction.insert(actionPolicy).values(
          SEEDS.map((seed) => ({
            ...seed,
            mode: "enforce",
            updatedAt: WHEN,
          })),
        );
        before = await read();
        await transaction.execute(sql.raw(notesPresetMigration().policy));
        after = await read();
        await transaction.execute(sql.raw(notesPresetMigration().policy));
        again = await read();
        // The rows go, and anything else the statement wrote goes back the way it was.
        transaction.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });

    // Every seed was there to be read, as it was written. `toEqual`, not `toMatchObject`: in this
    // runtime the second takes any date for any other (measured, Bun 1.3.11), and "the date it
    // was last changed is as it was" is one of the things this file says.
    expect(Object.keys(before).sort()).toEqual([...IDS].sort());
    for (const seed of SEEDS) {
      expect({ ...before[seed.id], version: "" }).toEqual({
        ...seed,
        mode: "enforce",
        updatedAt: WHEN,
        version: "",
      });
    }

    for (const seed of HOLD_IT) {
      const was = before[seed.id];
      const is = after[seed.id];
      // The expression is gone from the two lists, the new one is where it was, and every other
      // rule is where it was. `allow` is as it was — holding the old expression, where it did.
      expect(is?.ask).toEqual(swapped(seed.ask));
      expect(is?.deny).toEqual(swapped(seed.deny));
      expect([...(is?.ask ?? []), ...(is?.deny ?? [])]).not.toContain(WAS);
      expect([...(is?.ask ?? []), ...(is?.deny ?? [])]).toContain(IS);
      expect(is?.allow).toEqual(seed.allow);
      // Nothing else about the row: who last changed the boundary, and when, are as they were.
      expect({ ...is, ask: [], deny: [], version: "" }).toEqual({
        ...was,
        ask: [],
        deny: [],
        version: "",
      });
      // And it WAS written — the signal the next loop leans on is one that moves.
      expect(is?.version).not.toBe(was?.version);
    }

    // A row that does not hold it is not written at all: not its columns, not its version.
    for (const seed of DO_NOT) {
      expect(after[seed.id]).toEqual(before[seed.id]);
    }

    // The second run finds nothing: every row, the rewritten ones too, is the version it was.
    expect(again).toEqual(after);
  });

  test("moves an allowance that still stands under the old expression, leaves a withdrawn one, one whose clock has run out and a look-alike, never fails on a slot the new rule already holds, and a second run moves none", async () => {
    const named = process.env.DATABASE_URL;
    if (!named) {
      throw new Error(
        "DATABASE_URL names no database, and this test does not assume one.",
      );
    }
    const opened = database ?? createDatabase(named, TEST_POOL);
    database = opened;

    const BOT = `agent_m62_${run}`;
    const OTHER_BOT = `agent_m62_other_${run}`;
    /*
     * Either side of the statement's `now()`, by a day. Read off this process's clock while the
     * statement reads the database's: no two clocks a test run shares are a day apart. They were
     * a date in the calendar once, which is a test that starts failing on that date.
     */
    const DAY_MS = 24 * 60 * 60 * 1000;
    const LATER = new Date(Date.now() + DAY_MS);
    const EARLIER = new Date(Date.now() - DAY_MS);
    const file = (path: string) => ({
      scope: `file:${path}`,
      scopeKind: "file",
      scopeValue: path,
      subject: {
        kind: "file" as const,
        intent: "write_file" as const,
        file: { path },
        reason: "policy_ask" as const,
      },
    });
    /** [what it is, the row, the rule it should hold afterwards] */
    const GIVEN = [
      ["for good", { botId: BOT, rule: WAS, ...file("private/report.md") }, IS],
      [
        "for one conversation",
        {
          botId: BOT,
          rule: WAS,
          ...file("private/today.md"),
          tier: "thread",
          threadId: `thread-${run}`,
          expiresAt: LATER,
        },
        IS,
      ],
      [
        "for today, the day not over",
        {
          botId: BOT,
          rule: WAS,
          ...file("private/day.md"),
          tier: "day",
          expiresAt: LATER,
        },
        IS,
      ],
      /*
       * Its clock run out, and never withdrawn: nothing withdraws an answer that ended, until
       * somebody gives the same one again (`standing-approvals.ts`, `grant`). The store does not
       * count it as standing, and it is a record of what was given under the rule it was given
       * under — Codex's read of the pull request, which moved this row.
       */
      [
        "for one conversation, its clock run out",
        {
          botId: BOT,
          rule: WAS,
          ...file("private/ended.md"),
          tier: "thread",
          threadId: `thread-ended-${run}`,
          expiresAt: EARLIER,
        },
        WAS,
      ],
      [
        "for a day that is over",
        {
          botId: BOT,
          rule: WAS,
          ...file("private/yesterday.md"),
          tier: "day",
          expiresAt: EARLIER,
        },
        WAS,
      ],
      /*
       * The new rule's row here has run out AND STILL HOLDS THE SLOT — the table's unique index
       * reads `revoked_at` and not the clock. So the old one, which does still stand, is left, and
       * the statement does not fail on the pair: asked "is one standing there?" it would move the
       * old row onto the slot, and a deployment's migration would stop on a unique violation.
       */
      [
        "where one that has run out holds the slot",
        {
          botId: BOT,
          rule: WAS,
          ...file("slot.md"),
          tier: "day",
          expiresAt: LATER,
        },
        WAS,
      ],
      [
        "the one that has run out and holds it",
        {
          botId: BOT,
          rule: IS,
          ...file("slot.md"),
          tier: "day",
          expiresAt: EARLIER,
        },
        IS,
      ],
      // The same file under the new rule, but another Bot's: no reason to leave this one.
      ["beside another Bot's", { botId: BOT, rule: WAS, ...file("x.md") }, IS],
      [
        "another Bot's, under the new rule",
        { botId: OTHER_BOT, rule: IS, ...file("x.md") },
        IS,
      ],
      // Withdrawn: a record of what was given and taken back, under the rule it was given under.
      [
        "withdrawn",
        {
          botId: BOT,
          rule: WAS,
          ...file("private/old.md"),
          revokedAt: WHEN,
          revokedBy: "owner@m62.test",
        },
        WAS,
      ],
      // The new rule already has its own standing answer for this file: the old one is left, and
      // the statement does not fail on the pair (one allowance stands per Bot, rule, scope, width).
      [
        "where one already stands",
        { botId: BOT, rule: WAS, ...file("both.md") },
        WAS,
      ],
      [
        "the one that already stands",
        { botId: BOT, rule: IS, ...file("both.md") },
        IS,
      ],
      // Somebody's own rule, a floor's question, and a rule that has nothing to do with it.
      [
        "under a look-alike",
        { botId: BOT, rule: `${WAS} `, ...file("a.md") },
        `${WAS} `,
      ],
      ["under a floor", { botId: BOT, rule: "", ...file("b.md") }, ""],
      [
        "under another rule",
        { botId: BOT, rule: SUBMIT, ...file("c.md") },
        SUBMIT,
      ],
    ] as const;
    const seeds = GIVEN.map(([what, row]) => ({
      id: `m62-${what.replaceAll(/[^a-z]+/gi, "-")}-${run}`,
      grantedBy: "owner@m62.test",
      grantedAt: WHEN,
      ...row,
    }));
    const ids = seeds.map((seed) => seed.id);
    const moved = GIVEN.map(([, row, rule]) => rule !== row.rule);
    // What the seeds are worth: some move, some do not, and both pairs that would collide are
    // there — one whose other half stands, one whose other half has run out.
    expect(moved.filter(Boolean).length).toBe(4);
    expect(moved.filter((one) => !one).length).toBe(11);

    const allowance = {
      id: computerStandingApprovals.id,
      botId: computerStandingApprovals.botId,
      rule: computerStandingApprovals.rule,
      scope: computerStandingApprovals.scope,
      scopeKind: computerStandingApprovals.scopeKind,
      scopeValue: computerStandingApprovals.scopeValue,
      subject: computerStandingApprovals.subject,
      tier: computerStandingApprovals.tier,
      threadId: computerStandingApprovals.threadId,
      taskId: computerStandingApprovals.taskId,
      expiresAt: computerStandingApprovals.expiresAt,
      grantedBy: computerStandingApprovals.grantedBy,
      grantedAt: computerStandingApprovals.grantedAt,
      revokedAt: computerStandingApprovals.revokedAt,
      revokedBy: computerStandingApprovals.revokedBy,
      version: sql<string>`"computer_standing_approvals".ctid::text`,
    };
    type Held = Record<string, { rule: string; version: string }>;
    let before: Held = {};
    let after: Held = {};
    let again: Held = {};
    await opened
      .transaction(async (transaction) => {
        const read = async (): Promise<Held> =>
          Object.fromEntries(
            (
              await transaction
                .select(allowance)
                .from(computerStandingApprovals)
                .where(inArray(computerStandingApprovals.id, ids))
            ).map((row) => [row.id, row]),
          );
        await transaction.insert(agents).values(
          [BOT, OTHER_BOT].map((bot) => ({
            id: bot,
            name: bot,
            type: "remote_ag_ui" as const,
            configuration: {},
          })),
        );
        await transaction.insert(computerStandingApprovals).values(seeds);
        before = await read();
        await transaction.execute(sql.raw(notesPresetMigration().allowances));
        after = await read();
        await transaction.execute(sql.raw(notesPresetMigration().allowances));
        again = await read();
        // The Bots and their allowances go, and anything else the statement wrote goes back.
        transaction.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });

    expect(Object.keys(before).sort()).toEqual([...ids].sort());
    for (const [at, [what, row, rule]] of GIVEN.entries()) {
      const id = ids[at] ?? "";
      const was = before[id];
      const is = after[id];
      expect(`${what} · ${was?.rule}`).toBe(`${what} · ${row.rule}`);
      expect(`${what} · ${is?.rule}`).toBe(`${what} · ${rule}`);
      // Nothing else about the allowance: whose, for what, how wide, until when, who gave it.
      expect({ ...is, rule: "", version: "" }).toEqual({
        ...was,
        rule: "",
        version: "",
      });
      // Written where its rule moved, and not written at all where it did not.
      expect(`${what} · ${is?.version !== was?.version}`).toBe(
        `${what} · ${moved[at]}`,
      );
    }
    // The second run finds nothing to move: every row is the version it was.
    expect(again).toEqual(after);
  });
});
