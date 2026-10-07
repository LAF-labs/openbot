import { describe, expect, test } from "bun:test";
import {
  NOTES_PRESET,
  notesPresetMigration,
  presetOnTheScreen,
  RETIRED_NOTES_RULE,
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
 */
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

/**
 * The statement with its layout laid flat — and every string in it left EXACTLY as it is.
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
  test("swaps the expression the notes preset wrote for the one the screen offers now — whole, in `ask` and `deny`, in a row that holds it", () => {
    const was = quoted(RETIRED_NOTES_RULE);
    const is = quoted(presetOnTheScreen(NOTES_PRESET));
    /*
     * IF THIS FAILS BECAUSE THE PRESET CHANGED AGAIN: every deployment that pressed the button
     * holds the rule this migration left, and the screen has just stopped putting a name to it.
     * That wants the next migration, not an edit to this one — and then `is`, here, is the text
     * this file wrote, spelled out.
     */
    expect(laidFlat(notesPresetMigration())).toBe(
      [
        'UPDATE "action_policy" SET',
        `"ask" = array_replace( "ask", ${was}, ${is} ),`,
        `"deny" = array_replace( "deny", ${was}, ${is} )`,
        `WHERE ${was} = ANY ("ask") OR ${was} = ANY ("deny")`,
      ].join(" "),
    );
  });
});
