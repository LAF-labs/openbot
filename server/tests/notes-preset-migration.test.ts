import { describe, expect, test } from "bun:test";
import { NOTES_RULE, RETIRED_NOTES_RULE } from "../src/computer/policy-store";
import {
  NOTES_PRESET,
  notesPresetMigration,
  presetOnTheScreen,
} from "./support/boundary-presets";

/**
 * Migration 0062, held to its text.
 *
 * What it does to rows is `notes-preset-migration.integration.test.ts`, which needs a database.
 * This needs none, and holds the three things a row cannot show:
 *
 *  - WHAT IT LOOKS FOR is the expression the preset wrote, to the letter. One character off and
 *    it finds nothing on any deployment, quietly, and the old rule goes on not asking.
 *  - WHAT IT LEAVES is the rule the screen offers now, read off the screen. Anything else and the
 *    row holds a rule the screen has no name for, with the preset beside it still saying "Add".
 *  - NOTHING ELSE IS IN IT. A migration is what a database that ran it did; `allow`, another
 *    column or a wider WHERE arriving in this file later is a different migration.
 *
 * AND THE SAME TWO STRINGS ARE THE SERVER'S. The parser refuses the old expression where a policy
 * comes in and names the new one as what to write (`policy-store.ts`): a migration that looked
 * for one text while the parser refused another would leave a row the server then would not take
 * back from its own screen.
 */
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * A statement with its layout laid flat — and every string in it left EXACTLY as it is.
 *
 * The strings are the two expressions, and white space is a letter of an expression: the old one
 * with a space doubled finds nothing on any deployment. The first version of this collapsed white
 * space across the whole statement, strings included, and a mutation that put a second space into
 * the rule the migration leaves behind passed it.
 */
const laidFlat = (statement: string) =>
  statement
    .split(/('(?:[^']|'')*')/)
    .map((part, at) => (at % 2 === 1 ? part : part.replace(/\s+/g, " ")))
    .join("");

describe("migration 0062", () => {
  const was = quoted(RETIRED_NOTES_RULE);
  const is = quoted(presetOnTheScreen(NOTES_PRESET));

  test("the rule the server refuses is the one it looks for, and the one it names instead is the one the screen offers", () => {
    expect(NOTES_RULE).toBe(presetOnTheScreen(NOTES_PRESET));
    expect(RETIRED_NOTES_RULE).not.toBe(NOTES_RULE);
    // Each statement names both, whole, and no third expression.
    const { policy, allowances } = notesPresetMigration();
    for (const statement of [policy, allowances]) {
      const strings = [...statement.matchAll(/'(?:[^']|'')*'/g)]
        .map(([text]) => text)
        .filter((text) => text !== "''");
      expect([...new Set(strings)].sort()).toEqual([was, is].sort());
    }
  });

  test("swaps the expression the notes preset wrote for the one the screen offers now — whole, in `ask` and `deny`, in a row that holds it", () => {
    /*
     * IF THIS FAILS BECAUSE THE PRESET CHANGED AGAIN: every deployment that pressed the button
     * holds the rule this migration left, and the screen has just stopped putting a name to it.
     * That wants the next migration, not an edit to this one — and then `is`, here, is the text
     * this file wrote, spelled out.
     */
    expect(laidFlat(notesPresetMigration().policy)).toBe(
      [
        'UPDATE "action_policy" SET',
        `"ask" = array_replace( "ask", ${was}, ${is} ),`,
        `"deny" = array_replace( "deny", ${was}, ${is} )`,
        `WHERE ${was} = ANY ("ask") OR ${was} = ANY ("deny")`,
      ].join(" "),
    );
  });

  test("moves an allowance that still stands under the old expression to the new one — and only where no other already stands for the same answer", () => {
    /*
     * Not a withdrawn one (`revoked_at IS NULL`): that is a record of what was given and taken
     * back. And not onto a row that is already there: the table lets one allowance stand for one
     * Bot, rule, scope, width, conversation and task, so the old one is left where the new rule
     * already has its own — every column of that index is named here, or a migration that met two
     * would fail, and a deployment with it.
     */
    expect(laidFlat(notesPresetMigration().allowances)).toBe(
      [
        'UPDATE "computer_standing_approvals" AS "given"',
        `SET "rule" = ${is}`,
        `WHERE "given"."rule" = ${was}`,
        'AND "given"."revoked_at" IS NULL',
        "AND NOT EXISTS (",
        'SELECT 1 FROM "computer_standing_approvals" AS "standing"',
        `WHERE "standing"."rule" = ${is}`,
        'AND "standing"."revoked_at" IS NULL',
        'AND "standing"."bot_id" = "given"."bot_id"',
        'AND "standing"."scope" = "given"."scope"',
        'AND "standing"."tier" = "given"."tier"',
        `AND coalesce("standing"."thread_id", '') = coalesce("given"."thread_id", '')`,
        `AND coalesce("standing"."task_id", '') = coalesce("given"."task_id", '')`,
        ")",
      ].join(" "),
    );
  });
});
