import { describe, expect, test } from "bun:test";
import { rosterNotice } from "../src/lib/agents/roster-state";
import type { Reading } from "../src/lib/reading";

/**
 * THE ROSTER'S ONE LINE, OVER EVERY COMBINATION OF ITS TWO READS.
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
    expect(notice(failed, empty)).toEqual({ kind: "failed", what: "bots" });
    expect(notice(failed, ready)).toEqual({ kind: "failed", what: "bots" });
  });

  test("a list this account cannot have says so, with nothing to press", () => {
    expect(
      notice(
        { state: "unavailable", code: "laf:no_access", why: "not_allowed" },
        ready,
      ),
    ).toEqual({ kind: "unavailable", why: "not_allowed" });
  });

  test("nothing is said while the Bots are loading: the skeleton says it", () => {
    expect(notice(loading, failed)).toBeNull();
  });

  test("the rooms failing is said under the Bots that did load", () => {
    expect(notice(ready, failed, { shownCount: 3 })).toEqual({
      kind: "failed",
      what: "rooms",
    });
  });

  test("a refresh that failed over either list keeps the rows and says they are from before", () => {
    expect(notice(stale, ready, { shownCount: 2 })).toEqual({
      kind: "stale",
      isRetrying: false,
    });
    expect(notice(ready, stale, { shownCount: 2 })).toEqual({
      kind: "stale",
      isRetrying: false,
    });
    expect(
      notice({ state: "failed", previous: empty, isRetrying: true }, ready, {
        shownCount: 1,
      }),
    ).toEqual({ kind: "stale", isRetrying: true });
  });

  test("a roster with rows on it needs no line", () => {
    expect(notice(ready, ready, { shownCount: 4 })).toBeNull();
  });

  test("filtered to nothing is not empty", () => {
    expect(notice(ready, ready, { isSearching: true })).toEqual({
      kind: "no-match",
    });
  });

  test("empty only once both lists have answered, and never 'none yet' to somebody who hid theirs", () => {
    expect(notice(empty, loading)).toBeNull();
    expect(notice(empty, empty)).toEqual({ kind: "empty", hasHidden: false });
    expect(notice(empty, empty, { hasHidden: true })).toEqual({
      kind: "empty",
      hasHidden: true,
    });
    // A deployment with no rooms at all is simply a roster of Bots.
    expect(
      notice(empty, {
        state: "unavailable",
        code: "laf:not_found",
        why: "not_configured",
      }),
    ).toEqual({ kind: "empty", hasHidden: false });
  });
});
