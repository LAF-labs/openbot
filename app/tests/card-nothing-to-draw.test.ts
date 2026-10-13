import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  fieldsToFill,
  GALLERY_CONFIRMATIONS,
  holdsSomethingToShow,
} from "@shared/tools/gallery";
import { holdsSomethingToDraw } from "../src/components/gallery/gallery-card";
import type { GalleryComponent } from "../src/lib/copilot/gallery-registry";
import { toolJsonSchema } from "../src/lib/copilot/tool-schema";

/**
 * "NOTHING TO DRAW" IS ONE RULE, ASKED ON TWO SIDES (2026-10-13).
 *
 * The window asks it of a finished call before it draws the card (`holdsSomethingToDraw`, #189),
 * off the card's zod object. The turn asks it before it tells the Bot the card is on screen
 * (`holdsSomethingToShow`, `shared/tools/gallery.ts`), off the JSON Schema the window sent for the
 * same card. If they disagreed, the Bot would be told "shown" about a card nobody sees, or "not
 * shown" about one on the person's screen — so every card the window draws from a call is walked
 * through one table of calls, and both must say the same of each.
 */

/** Every card of the gallery's that is drawn from its call: the ones that are not questions. */
const GALLERY_DIRECTORY = join(import.meta.dir, "../src/components/gallery");
const CARDS: GalleryComponent[] = [];
for (const entry of readdirSync(GALLERY_DIRECTORY).sort()) {
  if (!entry.endsWith(".tsx")) continue;
  const module = (await import(join(GALLERY_DIRECTORY, entry))) as {
    GALLERY?: GalleryComponent[];
  };
  for (const card of module.GALLERY ?? []) {
    if (card.kind !== "decision") CARDS.push(card);
  }
}

/** A call's arguments, as anything a model may send where they belong. */
const CALLS: readonly (readonly [string, unknown])[] = [
  ["{}", {}],
  ["no arguments at all", null],
  ["a list where the arguments belong", []],
  ["a word where the arguments belong", "x"],
  ["a field no card shows", { extra: "x" }],
  ["a blank title", { title: "   " }],
  ["a title", { title: "이번 달" }],
  ["a title that is not a word", { title: 0 }],
  ["a number that is no number", { title: Number.NaN }],
  ["a flag", { title: false }],
  ["empty lists", { metrics: [], items: [], points: [], fields: [] }],
  ["one row with nothing in it", { metrics: [{}], items: [{}], points: [{}] }],
  [
    "one row with blanks in it",
    { fields: [{ label: "", value: " " }], items: [{ text: "" }] },
  ],
  ["one figure", { metrics: [{ label: "매출", value: "12건" }] }],
  ["one item", { items: [{ text: "박스 사기" }] }],
  ["one point", { points: [{ label: "1월", value: 12 }] }],
  ["a value alone", { value: 40 }],
  ["a quotation", { quote: "한 줄" }],
  ["a file's path", { path: "보고서/9월.csv" }],
  ["a blank path", { path: " " }],
  ["a report's name", { report: "activity" }],
  ["a null title", { title: null }],
];

describe("a card's call with nothing to draw", () => {
  test("the gallery has cards to walk, the key figures among them", () => {
    expect(CARDS.map((card) => card.name)).toContain("showMetrics");
    expect(CARDS.length).toBeGreaterThanOrEqual(10);
  });

  test.each(CARDS.map((card) => [card.name, card] as const))(
    "%s: the turn and the window say the same of every call",
    (_, card) => {
      const declared = toolJsonSchema(card.parameters);
      const said = CALLS.map(([what, args]) => [
        what,
        holdsSomethingToShow(declared, args),
      ]);
      const drawn = CALLS.map(([what, args]) => [
        what,
        holdsSomethingToDraw(card, args),
      ]);
      expect(said).toEqual(drawn);
      // And the table tells them apart: `{}` is nothing for every card, and no card is nothing for
      // every call — a rule that always said no would agree with itself too.
      expect(holdsSomethingToShow(declared, {})).toBe(false);
      expect(said.some(([, holds]) => holds === true)).toBe(true);
    },
  );

  /*
   * AND WHAT THE TURN SAYS OF A CARD THAT IS SHOWN IS WHAT THE CARD ITSELF DECLARES. The
   * quotation was in the window's gallery and not in the turn's table (found 2026-10-13): the Bot
   * was answered the sentence of a card nobody compiled, and the conversation did not take its
   * row for a card — so a quotation refused for having nothing in it kept a line no other card
   * keeps.
   */
  test.each(CARDS.map((card) => [card.name, card] as const))(
    "%s: the turn answers with the sentence the card declares",
    (name, card) => {
      expect(card.confirmation).toBeString();
      expect(GALLERY_CONFIRMATIONS[name]).toBe(card.confirmation as string);
    },
  );

  test("the key figures card: what is nothing, what is something, and which fields a refusal names", () => {
    const card = CARDS.find((one) => one.name === "showMetrics");
    const declared = toolJsonSchema(card?.parameters);
    expect(
      [{}, { extra: "x" }, { metrics: [{}] }, { title: " ", metrics: [] }].map(
        (args) => holdsSomethingToShow(declared, args),
      ),
    ).toEqual([false, false, false, false]);
    expect(
      [{ title: "이번 달" }, { metrics: [{ value: "12건" }] }].map((args) =>
        holdsSomethingToShow(declared, args),
      ),
    ).toEqual([true, true]);
    expect(fieldsToFill(declared)).toEqual(["title", "metrics"]);
  });

  test("a schema that requires nothing names the fields it has; one that names none, none", () => {
    expect(
      fieldsToFill({ type: "object", properties: { zone: {}, at: {} } }),
    ).toEqual(["zone", "at"]);
    expect(fieldsToFill({})).toEqual([]);
    expect(fieldsToFill(undefined)).toEqual([]);
  });
});
