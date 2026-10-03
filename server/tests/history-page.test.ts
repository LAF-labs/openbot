import { describe, expect, test } from "bun:test";
import { REACH_BACK, rowsOfPage } from "../src/turns/history";

/**
 * WHERE A PAGE OF A CONVERSATION BEGINS.
 *
 * What a window draws under an answer is read from the steps of the answer's own turn: the pages
 * it was read from, the record of what was done for it, and whose data it was said from — a line
 * a weather answer owes by law. A page that began on the answer had none of them to read, and the
 * answer stood at the top of the conversation with no source under it until the person asked for
 * the page above (Codex on pull request 50). So a page begins where a turn began.
 *
 * The rows are newest first, as they are read: the first `limit` are the page, and what follows is
 * what it may reach back into.
 */

/** A turn as it is stored, oldest first: the person's message, then calls, results and words. */
const turn = (steps: number) => [
  "user",
  ...Array.from({ length: steps }, () => ["assistant", "tool"]).flat(),
  "assistant",
];
/** Newest first, as the store hands them over. */
const read = (...turns: string[][]) => turns.flat().reverse();
/** The page kept, oldest first. */
const kept = (roles: string[], limit: number) =>
  roles.slice(0, rowsOfPage(roles, limit)).reverse();

describe("a page of a conversation", () => {
  test("begins at the person's message, wherever the limit would have cut the turn", () => {
    const rows = read(turn(1), turn(2));
    // The newer turn is six rows: the person, two calls and their results, and the answer.
    for (const limit of [1, 2, 3, 4, 5]) {
      expect([limit, kept(rows, limit)]).toEqual([limit, turn(2)]);
    }
    // Cut exactly at the person's message, it is the page as asked for.
    expect(kept(rows, 6)).toEqual(turn(2));
    // And a cut inside the turn before reaches back to that one's beginning.
    for (const limit of [7, 8, 9]) {
      expect([limit, kept(rows, limit)]).toEqual([
        limit,
        [...turn(1), ...turn(2)],
      ]);
    }
  });

  test("on the answer alone would have had nothing to read its source from: the weather's call comes with it", () => {
    // The seam the line was lost at: a page of one row, the answer, its call on the page above.
    const rows = read(["user", "assistant", "tool", "assistant"]);
    expect(kept(rows, 1)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  test("keeps the person's messages that stand together: a page begins at one of them", () => {
    const rows = read(["user"], ["user", "assistant"]);
    expect(kept(rows, 1)).toEqual(["user", "assistant"]);
    expect(kept(rows, 2)).toEqual(["user", "assistant"]);
    expect(kept(rows, 3)).toEqual(["user", "user", "assistant"]);
  });

  test("a turn longer than the reach is cut where it always was: never on a result", () => {
    // Forty calls and their results above the page: the person's message is out of reach.
    const long = turn(REACH_BACK);
    const rows = read(long).slice(0, 4 + REACH_BACK + 1);
    // What was read does not hold the turn's beginning.
    expect(rows.includes("user")).toBe(false);
    // A limit that lands on a result reaches back one, to the call that asked for it…
    expect(kept(rows, 2).at(0)).toBe("assistant");
    expect(kept(rows, 2)).toHaveLength(3);
    // …and one that lands on a call is the page as asked for.
    expect(kept(rows, 3)).toHaveLength(3);
    expect(kept(rows, 3).at(0)).toBe("assistant");
  });

  test("takes what there is: fewer rows than the limit, or none", () => {
    expect(rowsOfPage([], 80)).toBe(0);
    expect(kept(read(turn(0)), 80)).toEqual(["user", "assistant"]);
    // A conversation that begins with the Bot: nothing above it to reach for.
    expect(kept(["assistant"], 80)).toEqual(["assistant"]);
    expect(kept(read(["assistant", "tool"]), 1)).toEqual(["assistant", "tool"]);
  });
});
