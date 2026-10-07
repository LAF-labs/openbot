import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { actionPolicy } from "../src/db/schema";
import {
  NOTES_PRESET,
  notesPresetMigration,
  presetOnTheScreen,
  RETIRED_NOTES_RULE,
} from "./support/boundary-presets";
import { TEST_POOL } from "./support/database";

/**
 * Migration 0062, run over rows: a stored copy of the boundaries screen's notes preset is rewritten
 * to the rule that preset writes now, and nothing else is.
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
        await transaction.execute(sql.raw(notesPresetMigration()));
        after = await read();
        await transaction.execute(sql.raw(notesPresetMigration()));
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
});
