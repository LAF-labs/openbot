import { describe, expect, test } from "bun:test";
import {
  type RosterNotice,
  rosterNotice,
} from "../src/lib/agents/roster-state";
import type { Reading } from "../src/lib/reading";

/**
 * WHAT THE ROSTER SAYS BESIDES ITS ROWS, OVER EVERY COMBINATION OF ITS TWO READS.
 *
 * MEASURED 2026-09-18 before this: with `/api/agents` answering 500, the roster said
 * 아직 봇이 없습니다 — the empty line was drawn whenever the Bots list was not pending and had no
 * rows, and a list that failed has no rows. Each case here is a thing the column could say.
 */

const ready: Reading<unknown> = { state: "ready", data: [1] };
const empty: Reading<unknown> = { state: "empty", data: [] };
const loading: Reading<unknown> = { state: "loading" };
const failed: Reading<unknown> = {
  state: "failed",
  previous: null,
  isRetrying: false,
};
const stale: Reading<unknown> = {
  state: "failed",
  previous: { state: "ready", data: [1] },
  isRetrying: false,
};

const notice = (
  bots: Reading<unknown>,
  rooms: Reading<unknown>,
  extra: Partial<{
    isSearching: boolean;
    shownCount: number;
    hasHidden: boolean;
  }> = {},
) =>
  rosterNotice({
    bots,
    rooms,
    isSearching: false,
    shownCount: 0,
    hasHidden: false,
    ...extra,
  });

describe("the roster's line", () => {
  test("a Bots list that failed says so — never that there are none", () => {
    const expected: RosterNotice = {
      line: {
        kind: "failed",
        message: "Your Bots could not be loaded.",
        isRetrying: false,
      },
      list: null,
    };
    expect(notice(failed, empty)).toEqual(expected);
    expect(notice(failed, ready)).toEqual(expected);
  });

  test("a list this account cannot have says so, with nothing to press", () => {
    expect(
      notice(
        { state: "unavailable", code: "laf:no_access", why: "not_allowed" },
        ready,
      ),
    ).toEqual({
      line: {
        kind: "unavailable",
        message: "This account cannot see this here.",
      },
      list: null,
    });
    expect(
      notice(
        { state: "unavailable", code: "laf:not_found", why: "not_configured" },
        ready,
      ).line,
    ).toEqual({ kind: "unavailable", message: "Bots are not offered here." });
  });

  test("nothing is said while the Bots are loading: the skeleton says it", () => {
    expect(notice(loading, failed)).toEqual({ line: null, list: null });
  });

  test("the rooms failing is said beside the Bots that did load", () => {
    expect(notice(ready, failed, { shownCount: 3 })).toEqual({
      line: {
        kind: "failed",
        message: "Your conversations could not be loaded.",
        isRetrying: false,
      },
      list: null,
    });
  });

  test("a refresh that failed over either list keeps the rows and says they are from before", () => {
    const quiet: RosterNotice = {
      line: { kind: "stale", isRetrying: false },
      list: null,
    };
    expect(notice(stale, ready, { shownCount: 2 })).toEqual(quiet);
    expect(notice(ready, stale, { shownCount: 2 })).toEqual(quiet);
    expect(
      notice({ state: "failed", previous: empty, isRetrying: true }, ready, {
        shownCount: 1,
      }).line,
    ).toEqual({ kind: "stale", isRetrying: true });
  });

  test("a roster with rows on it says nothing", () => {
    expect(notice(ready, ready, { shownCount: 4 })).toEqual({
      line: null,
      list: null,
    });
  });

  test("filtered to nothing is not empty", () => {
    expect(notice(ready, ready, { isSearching: true })).toEqual({
      line: null,
      list: "no-match",
    });
  });

  test("empty only once both lists have answered, and never 'none yet' to somebody who hid theirs", () => {
    expect(notice(empty, loading)).toEqual({ line: null, list: null });
    expect(notice(empty, empty)).toEqual({ line: null, list: "empty" });
    expect(notice(empty, empty, { hasHidden: true })).toEqual({
      line: null,
      list: "all-hidden",
    });
    // A deployment with no rooms at all is simply a roster of Bots.
    expect(
      notice(empty, {
        state: "unavailable",
        code: "laf:not_found",
        why: "not_configured",
      }),
    ).toEqual({ line: null, list: "empty" });
  });
});
