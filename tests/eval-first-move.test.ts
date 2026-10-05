import { describe, expect, test } from "bun:test";
import {
  categoryOf,
  type EvalSet,
  isBorderline,
  type Labelled,
  moveOf,
  ORDINARY_FILE,
  type Row,
  SETS,
  sentRates,
  tallyOf,
  verdictOf,
} from "../evals/first-move";
import {
  FIRST_MOVE_MAX_CHARS,
  FIRST_MOVES,
  kindsToAsk,
} from "../server/src/turns/first-move";

/**
 * THE FIRST MOVE'S EVAL, JUDGED WITHOUT A NETWORK (`evals/first-move.ts`).
 *
 * The eval decides whether a kind of first move may be wired at all, so what it counts as a wrong
 * move, and what fails it, is held here: a scoring rule that quietly stopped counting would pass
 * every kind for ever. The sets themselves are held to what their labellers were asked for.
 */

const calendar = SETS.find((set) => set.kind === "calendar") as EvalSet;
const weather = SETS.find((set) => set.kind === "weather") as EvalSet;

const row = (
  labels: Record<string, unknown>,
  decided: Record<string, number> | null,
  asked: Row["asked"] = ["calendar"],
): Row => ({
  text: `message ${Math.random()}`,
  ...labels,
  asked,
  decided,
  ms: 200,
  noAnswer: false,
});
const SURE = { schedule: 0.95, today: 0.95 };

describe("the first move's eval: what a row counts as", () => {
  test("a message is wanted, a near-miss, unwanted, or asks for more — by its labeller's fields and note", () => {
    const of = (labels: Record<string, unknown>) =>
      categoryOf(calendar, { text: "t", ...labels });
    expect(of({ schedule: true, today: true })).toBe("wants");
    expect(of({ schedule: true, today: false })).toBe("near");
    expect(of({ schedule: false, today: true })).toBe("unwanted");
    expect(
      of({ schedule: true, today: true, note: "both: and the mail" }),
    ).toBe("both");
    expect(isBorderline({ text: "t", note: "Borderline: either way" })).toBe(
      true,
    );
    expect(isBorderline({ text: "t", note: "not borderline at all" })).toBe(
      false,
    );
  });

  test("a move is the product's: every question at its bar, one kind only, and nothing unasked", () => {
    expect(moveOf(row({}, SURE))).toBe("calendar");
    expect(moveOf(row({}, { ...SURE, today: 0.79 }))).toBeNull();
    expect(moveOf(row({}, null))).toBeNull();
    // Sure of a kind nobody asked about is not a move of it.
    expect(moveOf(row({}, { mail: 0.99, unfiltered: 0.99 }))).toBeNull();
    const two = row({}, { ...SURE, mail: 0.99, unfiltered: 0.99 }, [
      "calendar",
      "mail",
    ]);
    expect(moveOf(two)).toBe("ambiguous");
    // Other bars are tried without touching the product's.
    expect(
      moveOf(row({}, { ...SURE, today: 0.79 }), {
        calendar: { schedule: 0.5, today: 0.5 },
      }),
    ).toBe("calendar");
  });

  test("the tally counts right, wrong by category, missed, and leaves the rows that asked for more out of both", () => {
    const rows = [
      row({ schedule: true, today: true }, SURE),
      row({ schedule: true, today: true }, { ...SURE, schedule: 0.1 }),
      row({ schedule: true, today: false }, SURE),
      row({ schedule: false, today: true }, SURE),
      row({ schedule: false, today: true, note: "borderline: maybe" }, SURE),
      row({ schedule: true, today: true, note: "both: and mail" }, SURE),
      row({ schedule: false, today: false }, { forecast: 0.9, ownPlace: 0.9 }, [
        "weather",
      ]),
    ];
    const tally = tallyOf(calendar, rows);
    expect({
      moved: tally.moved.length,
      right: tally.right.length,
      wrong: tally.wrong.length,
      near: tally.wrongNear.length,
      unwanted: tally.wrongUnwanted.length,
      borderline: tally.wrongBorderline.length,
      should: tally.should.length,
      missed: tally.missed.length,
      both: tally.movedOnBoth.length,
      another: tally.movedAnother.length,
    }).toEqual({
      moved: 4,
      right: 1,
      wrong: 3,
      near: 1,
      unwanted: 2,
      borderline: 1,
      should: 2,
      missed: 1,
      both: 1,
      another: 1,
    });
  });
});

describe("the first move's eval: what fails a kind", () => {
  const right = (n: number) =>
    Array.from({ length: n }, () => row({ schedule: true, today: true }, SURE));

  test("one wrong move on a message its labeller was sure of fails it, however high the precision", () => {
    for (const wrong of [
      { schedule: true, today: false },
      { schedule: false, today: false },
    ]) {
      const verdict = verdictOf(
        calendar,
        tallyOf(calendar, [...right(99), row(wrong, SURE)]),
      );
      expect(verdict.failed).toBe(true);
      expect(verdict.precision).toBe(0.99);
    }
  });

  test("a wrong move on a borderline message is counted in the precision and does not fail it alone", () => {
    const borderline = { schedule: false, today: true, note: "borderline: x" };
    const few = verdictOf(
      calendar,
      tallyOf(calendar, [...right(40), row(borderline, SURE)]),
    );
    expect(few.failed).toBe(false);
    // Enough of them is a precision under the floor, and that fails it.
    const many = verdictOf(
      calendar,
      tallyOf(calendar, [
        ...right(9),
        row(borderline, SURE),
        row(borderline, SURE),
      ]),
    );
    expect(many.failed).toBe(true);
    expect(many.why.join(" ")).toContain("precision");
  });

  test("the weather's named place fails it even when marked borderline; a kind that never moves is not passed", () => {
    const named = {
      text: "t",
      forecast: true,
      ownPlace: false,
      note: "borderline: x",
      asked: ["weather"] as const,
      decided: { forecast: 0.9, ownPlace: 0.9 },
      ms: 1,
      noAnswer: false,
    };
    expect(verdictOf(weather, tallyOf(weather, [named])).failed).toBe(true);
    const never = verdictOf(calendar, tallyOf(calendar, []));
    expect([never.failed, never.precision]).toEqual([true, null]);
  });
});

describe("the first move's eval: the labelled sets", () => {
  test("every kind has a set, written to the sizes its labeller was asked for, with nothing said twice", async () => {
    expect(SETS.map((set) => set.kind)).toEqual([...FIRST_MOVES]);
    for (const set of SETS) {
      const rows = JSON.parse(
        await Bun.file(new URL(`../evals/${set.file}`, import.meta.url)).text(),
      ) as Labelled[];
      expect(new Set(rows.map((one) => one.text)).size).toBe(rows.length);
      for (const one of rows) {
        expect(typeof one[set.wanted]).toBe("boolean");
        expect(typeof one[set.plain]).toBe("boolean");
      }
      const count = (category: string) =>
        rows.filter((one) => categoryOf(set, one) === category).length;
      expect(count("wants")).toBeGreaterThanOrEqual(60);
      expect(count("near")).toBeGreaterThanOrEqual(40);
      expect(count("unwanted")).toBeGreaterThanOrEqual(100);
      // Borderline is marked before anything is run, or the verdict's one exception is empty.
      expect(rows.filter(isBorderline).length).toBeGreaterThanOrEqual(10);
      // The negatives are not easy ones: twenty at least carry words that get them asked about
      // (42, 30 and 26 with the lists as narrowed on 2026-10-05; 83, 72 and 59 before).
      const unwantedAsked = rows.filter(
        (one) =>
          categoryOf(set, one) === "unwanted" &&
          one.text.trim().length <= FIRST_MOVE_MAX_CHARS &&
          kindsToAsk(one.text).includes(set.kind),
      ).length;
      expect(unwantedAsked).toBeGreaterThanOrEqual(20);
    }
  });
});

describe("the first move's eval: what the words cost where they pay nothing", () => {
  test("of ordinary chat that wants none of it, each kind's words send under 3% and the three together under 5%", async () => {
    const ordinary = (
      JSON.parse(
        await Bun.file(
          new URL(`../evals/${ORDINARY_FILE}`, import.meta.url),
        ).text(),
      ) as Labelled[]
    ).map((one) => one.text);
    expect(ordinary.length).toBeGreaterThanOrEqual(300);
    expect(new Set(ordinary).size).toBe(ordinary.length);
    const cost = sentRates(ordinary, kindsToAsk);
    /*
     * Of 347: the first lists sent 18 for the weather, 26 for the calendar and 5 for the mail, 49
     * messages in all (14.1%). Narrowed, and before any list had been gone over against this set,
     * 18, 1 and 4. After the one pass each list was allowed over it: none. The numbers held
     * here are the fitted ones; a message sent again fails this, and says which list widened.
     */
    expect(cost.byKind.weather / cost.of).toBeLessThan(0.03);
    expect(cost.byKind.calendar / cost.of).toBeLessThan(0.03);
    expect(cost.byKind.mail / cost.of).toBeLessThan(0.03);
    expect(cost.any / cost.of).toBeLessThan(0.05);
    expect(cost.byKind).toEqual({ weather: 0, calendar: 0, mail: 0 });
  });

  test("a rate is counted per kind and once for a message sent for two", () => {
    expect(
      sentRates(["a", "b", "c", "d"], (text) =>
        text === "a" ? ["calendar", "mail"] : text === "b" ? ["mail"] : [],
      ),
    ).toEqual({
      any: 2,
      byKind: { weather: 0, calendar: 1, mail: 2 },
      of: 4,
    });
  });
});
